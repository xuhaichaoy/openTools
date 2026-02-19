use crate::{Error, Result};
use jsonwebtoken::{decode, encode, EncodingKey, Header};
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
}

impl AuthService {
    pub fn new(jwt_secret: String, redis: redis::Client) -> Self {
        Self { jwt_secret, redis }
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
            exp: now + 15 * 60, // 15 分钟
            token_type: "access".to_string(),
        };

        let refresh_claims = Claims {
            sub: user_id.to_string(),
            iat: now,
            exp: now + 30 * 24 * 60 * 60, // 30 天
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
        decode::<Claims>(
            token,
            &jsonwebtoken::DecodingKey::from_secret(self.jwt_secret.as_bytes()),
            &jsonwebtoken::Validation::default(),
        )
        .map(|data| data.claims)
        .map_err(|_| Error::Unauthorized("Invalid token".into()))
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
