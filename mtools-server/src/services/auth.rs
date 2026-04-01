use crate::{Error, Result};
use jsonwebtoken::{decode, encode, errors::ErrorKind, EncodingKey, Header, Validation};
use serde::{Deserialize, Serialize};
use std::time::{SystemTime, UNIX_EPOCH};

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct Claims {
    pub sub: String,
    pub exp: usize,
    pub iat: usize,
    /// "access" | "refresh"
    #[serde(default = "default_token_type")]
    pub token_type: String,
}

fn default_token_type() -> String {
    "access".to_string()
}

pub struct TokenPair {
    pub access_token: String,
    pub refresh_token: String,
}

pub struct AuthService {
    jwt_secret: String,
    redis: redis::Client,
    access_token_ttl_secs: usize,
    refresh_token_ttl_secs: usize,
    jwt_leeway_secs: u64,
}

impl AuthService {
    pub fn new(
        jwt_secret: String,
        redis: redis::Client,
        access_token_ttl_secs: u64,
        refresh_token_ttl_secs: u64,
        jwt_leeway_secs: u64,
    ) -> Self {
        Self {
            jwt_secret,
            redis,
            access_token_ttl_secs: access_token_ttl_secs as usize,
            refresh_token_ttl_secs: refresh_token_ttl_secs as usize,
            jwt_leeway_secs,
        }
    }

    fn now_secs() -> Result<usize> {
        SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .map(|d| d.as_secs() as usize)
            .map_err(|e| Error::Internal(e.into()))
    }

    /// 生成 access + refresh token 对
    pub fn generate_token_pair(&self, user_id: &str) -> Result<TokenPair> {
        let now = Self::now_secs()?;

        let access_claims = Claims {
            sub: user_id.to_string(),
            iat: now,
            exp: now + self.access_token_ttl_secs,
            token_type: "access".to_string(),
        };

        let refresh_claims = Claims {
            sub: user_id.to_string(),
            iat: now,
            exp: now + self.refresh_token_ttl_secs,
            token_type: "refresh".to_string(),
        };

        let key = EncodingKey::from_secret(self.jwt_secret.as_bytes());
        let access_token = encode(&Header::default(), &access_claims, &key)
            .map_err(|e| Error::Internal(e.into()))?;
        let refresh_token = encode(&Header::default(), &refresh_claims, &key)
            .map_err(|e| Error::Internal(e.into()))?;

        Ok(TokenPair {
            access_token,
            refresh_token,
        })
    }

    /// 仅生成 access token（向后兼容）
    pub fn generate_token(&self, user_id: &str) -> Result<String> {
        let pair = self.generate_token_pair(user_id)?;
        Ok(pair.access_token)
    }

    pub fn validate_token(&self, token: &str) -> Result<Claims> {
        let mut validation = Validation::default();
        validation.leeway = self.jwt_leeway_secs;

        decode::<Claims>(
            token,
            &jsonwebtoken::DecodingKey::from_secret(self.jwt_secret.as_bytes()),
            &validation,
        )
        .map(|data| data.claims)
        .map_err(|error| {
            let message = match error.kind() {
                ErrorKind::ExpiredSignature => "Token expired",
                ErrorKind::InvalidSignature => "Token signature mismatch",
                ErrorKind::InvalidToken => "Invalid token",
                ErrorKind::InvalidAlgorithm => "Unsupported token algorithm",
                _ => "Invalid token",
            };
            tracing::warn!("JWT validation failed: {message}");
            Error::Unauthorized(message.into())
        })
    }

    /// 验证 refresh token 并生成新的 token 对
    pub fn refresh_tokens(&self, refresh_token: &str) -> Result<TokenPair> {
        let claims = self.validate_token(refresh_token)?;
        if claims.token_type != "refresh" {
            return Err(Error::Unauthorized("Not a refresh token".into()));
        }
        self.generate_token_pair(&claims.sub)
    }

    /// 发送 SMS 验证码（生成随机 6 位码，存 Redis 5 分钟）
    pub async fn send_sms_code(&self, phone: &str) -> Result<String> {
        use rand::Rng;
        let code: String = format!("{:06}", rand::rng().random_range(0..1000000u32));

        // 存入 Redis，5 分钟过期
        let key = format!("sms:code:{}", phone);
        let mut conn = self
            .redis
            .get_multiplexed_async_connection()
            .await
            .map_err(|e| Error::Internal(anyhow::anyhow!("Redis error: {}", e)))?;

        redis::cmd("SET")
            .arg(&key)
            .arg(&code)
            .arg("EX")
            .arg(300) // 5 分钟
            .query_async::<()>(&mut conn)
            .await
            .map_err(|e| Error::Internal(anyhow::anyhow!("Redis SET error: {}", e)))?;

        // TODO: 接入真实 SMS 服务（阿里云/腾讯云），目前日志输出
        tracing::info!("[SMS] Code {} sent to {}", code, phone);

        Ok(code)
    }

    /// 验证 SMS 验证码（从 Redis 读取比对，验证后删除）
    pub async fn verify_sms_code(&self, phone: &str, code: &str) -> Result<bool> {
        let key = format!("sms:code:{}", phone);
        let mut conn = self
            .redis
            .get_multiplexed_async_connection()
            .await
            .map_err(|e| Error::Internal(anyhow::anyhow!("Redis error: {}", e)))?;

        let stored: Option<String> = redis::cmd("GET")
            .arg(&key)
            .query_async(&mut conn)
            .await
            .map_err(|e| Error::Internal(anyhow::anyhow!("Redis GET error: {}", e)))?;

        match stored {
            Some(stored_code) if stored_code == code => {
                // 验证成功，删除验证码
                let _ = redis::cmd("DEL")
                    .arg(&key)
                    .query_async::<()>(&mut conn)
                    .await;
                Ok(true)
            }
            _ => Ok(false),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn service_with_ttl(access_ttl_secs: u64, leeway_secs: u64) -> AuthService {
        AuthService::new(
            "unit-test-secret".to_string(),
            redis::Client::open("redis://127.0.0.1/").expect("redis client"),
            access_ttl_secs,
            7 * 24 * 60 * 60,
            leeway_secs,
        )
    }

    #[test]
    fn generate_token_pair_uses_configured_ttl() {
        let service = service_with_ttl(3600, 0);
        let pair = service.generate_token_pair("user-1").expect("token pair");
        let claims = service.validate_token(&pair.access_token).expect("claims");
        assert_eq!(claims.exp.saturating_sub(claims.iat), 3600);
        assert_eq!(claims.token_type, "access");
    }

    #[test]
    fn validate_token_reports_expired_token() {
        let service = service_with_ttl(1, 0);
        let pair = service.generate_token_pair("user-2").expect("token pair");
        std::thread::sleep(std::time::Duration::from_secs(2));
        let error = service
            .validate_token(&pair.access_token)
            .expect_err("expired");
        match error {
            Error::Unauthorized(message) => assert_eq!(message, "Token expired"),
            other => panic!("unexpected error: {other:?}"),
        }
    }

    #[test]
    fn validate_token_allows_small_clock_skew() {
        let service = service_with_ttl(1, 2);
        let pair = service.generate_token_pair("user-3").expect("token pair");
        std::thread::sleep(std::time::Duration::from_secs(2));
        let claims = service.validate_token(&pair.access_token).expect("leeway");
        assert_eq!(claims.sub, "user-3");
    }
}
