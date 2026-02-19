//! API Key 本地加解密（AES-256-GCM）
//!
//! 密文格式：`enc:<base64(nonce || ciphertext)>`
//! 密钥派生：HKDF-SHA256(machine_seed, salt)

use aes_gcm::{
    aead::{Aead, KeyInit, OsRng},
    AeadCore, Aes256Gcm, Nonce,
};
use base64::{engine::general_purpose::STANDARD as B64, Engine};
use hkdf::Hkdf;
use sha2::Sha256;

const ENC_PREFIX: &str = "enc:";
const SALT: &[u8] = b"mtools-api-key-v1";
const INFO: &[u8] = b"mtools-aes256gcm";

fn derive_key() -> [u8; 32] {
    let seed = machine_seed();
    let hk = Hkdf::<Sha256>::new(Some(SALT), seed.as_bytes());
    let mut key = [0u8; 32];
    hk.expand(INFO, &mut key)
        .expect("32 bytes is a valid length for HKDF-SHA256");
    key
}

/// Collects a stable per-machine seed from hostname + username + home dir.
fn machine_seed() -> String {
    let host = hostname::get()
        .map(|h| h.to_string_lossy().to_string())
        .unwrap_or_else(|_| "unknown-host".into());
    let user = std::env::var("USER")
        .or_else(|_| std::env::var("USERNAME"))
        .unwrap_or_else(|_| "unknown-user".into());
    let home = dirs::home_dir()
        .map(|p| p.to_string_lossy().to_string())
        .unwrap_or_default();
    format!("{host}:{user}:{home}:mtools-local-key")
}

pub fn encrypt_api_key(plaintext: &str) -> Result<String, String> {
    if plaintext.is_empty() {
        return Ok(String::new());
    }
    let key = derive_key();
    let cipher = Aes256Gcm::new_from_slice(&key).map_err(|e| e.to_string())?;
    let nonce = Aes256Gcm::generate_nonce(&mut OsRng);
    let ciphertext = cipher
        .encrypt(&nonce, plaintext.as_bytes())
        .map_err(|e| e.to_string())?;

    let mut blob = nonce.to_vec();
    blob.extend_from_slice(&ciphertext);
    Ok(format!("{ENC_PREFIX}{}", B64.encode(&blob)))
}

pub fn decrypt_api_key(value: &str) -> Result<String, String> {
    if value.is_empty() {
        return Ok(String::new());
    }
    let payload = value
        .strip_prefix(ENC_PREFIX)
        .ok_or_else(|| "not an encrypted value".to_string())?;

    let blob = B64.decode(payload).map_err(|e| e.to_string())?;
    if blob.len() < 12 {
        return Err("ciphertext too short".into());
    }
    let (nonce_bytes, ciphertext) = blob.split_at(12);
    let nonce = Nonce::from_slice(nonce_bytes);

    let key = derive_key();
    let cipher = Aes256Gcm::new_from_slice(&key).map_err(|e| e.to_string())?;
    let plaintext = cipher
        .decrypt(nonce, ciphertext)
        .map_err(|_| "decryption failed (wrong key or corrupted data)".to_string())?;

    String::from_utf8(plaintext).map_err(|e| e.to_string())
}

/// Transparently decrypt: if the value has the `enc:` prefix, decrypt it;
/// otherwise return as-is (legacy plaintext).
pub fn maybe_decrypt(value: &str) -> String {
    if value.starts_with(ENC_PREFIX) {
        decrypt_api_key(value).unwrap_or_else(|e| {
            log::warn!("Failed to decrypt API key: {e}");
            String::new()
        })
    } else {
        value.to_string()
    }
}
