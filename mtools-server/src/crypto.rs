//! API Key 服务端加解密（AES-256-GCM）
//!
//! 密文格式：`enc:<base64(nonce || ciphertext)>`
//! 密钥来源：环境变量 ENCRYPTION_KEY（Base64 编码的 32 字节密钥）

use aes_gcm::{
    aead::{Aead, KeyInit, OsRng},
    AeadCore, Aes256Gcm, Nonce,
};
use base64::{engine::general_purpose::STANDARD as B64, Engine};
use once_cell::sync::Lazy;

const ENC_PREFIX: &str = "enc:";

static ENCRYPTION_KEY: Lazy<[u8; 32]> = Lazy::new(|| match std::env::var("ENCRYPTION_KEY") {
    Ok(key_b64) => {
        let decoded = B64
            .decode(key_b64.trim())
            .expect("ENCRYPTION_KEY must be a valid base64-encoded 32-byte key");
        assert_eq!(
            decoded.len(),
            32,
            "ENCRYPTION_KEY must be exactly 32 bytes (got {})",
            decoded.len()
        );
        let mut key = [0u8; 32];
        key.copy_from_slice(&decoded);
        key
    }
    Err(_) => {
        tracing::warn!(
            "ENCRYPTION_KEY not set — using fallback key. \
                 Set a 32-byte base64 key in production!"
        );
        use hkdf::Hkdf;
        use sha2::Sha256;
        let hk = Hkdf::<Sha256>::new(Some(b"mtools-dev-salt"), b"mtools-dev-fallback");
        let mut key = [0u8; 32];
        hk.expand(b"mtools-server-aes256gcm", &mut key)
            .expect("valid length");
        key
    }
});

pub fn encrypt(plaintext: &str) -> anyhow::Result<String> {
    if plaintext.is_empty() {
        return Ok(String::new());
    }
    let cipher = Aes256Gcm::new_from_slice(&*ENCRYPTION_KEY).map_err(|e| anyhow::anyhow!("{e}"))?;
    let nonce = Aes256Gcm::generate_nonce(&mut OsRng);
    let ciphertext = cipher
        .encrypt(&nonce, plaintext.as_bytes())
        .map_err(|e| anyhow::anyhow!("encrypt: {e}"))?;

    let mut blob = nonce.to_vec();
    blob.extend_from_slice(&ciphertext);
    Ok(format!("{ENC_PREFIX}{}", B64.encode(&blob)))
}

pub fn decrypt(value: &str) -> anyhow::Result<String> {
    if value.is_empty() {
        return Ok(String::new());
    }
    let payload = value
        .strip_prefix(ENC_PREFIX)
        .ok_or_else(|| anyhow::anyhow!("not an encrypted value"))?;

    let blob = B64.decode(payload)?;
    if blob.len() < 12 {
        anyhow::bail!("ciphertext too short");
    }
    let (nonce_bytes, ciphertext) = blob.split_at(12);
    let nonce = Nonce::from_slice(nonce_bytes);

    let cipher = Aes256Gcm::new_from_slice(&*ENCRYPTION_KEY).map_err(|e| anyhow::anyhow!("{e}"))?;
    let plaintext = cipher
        .decrypt(nonce, ciphertext)
        .map_err(|_| anyhow::anyhow!("decryption failed"))?;

    Ok(String::from_utf8(plaintext)?)
}

/// Transparently decrypt: if prefixed with `enc:`, decrypt; otherwise return as-is.
pub fn maybe_decrypt(value: &str) -> String {
    if value.starts_with(ENC_PREFIX) {
        decrypt(value).unwrap_or_else(|e| {
            tracing::warn!("Failed to decrypt key: {e}");
            String::new()
        })
    } else {
        value.to_string()
    }
}

/// Mask an API key for display: `sk-abc1****9xyz`
pub fn mask_key(key: &str) -> String {
    if key.is_empty() {
        return String::new();
    }
    let prefix_len = 6.min(key.len());
    let suffix_len = 4.min(key.len().saturating_sub(prefix_len + 2));
    if key.len() <= prefix_len + suffix_len + 2 {
        return "****".to_string();
    }
    format!(
        "{}****{}",
        &key[..prefix_len],
        &key[key.len() - suffix_len..]
    )
}
