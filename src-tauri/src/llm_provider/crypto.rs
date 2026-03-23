use aes_gcm::{
    aead::{Aead, KeyInit},
    Aes256Gcm, Nonce,
};
use pbkdf2::pbkdf2_hmac;
use rand::RngCore;
use sha2::Sha256;
use std::path::Path;

const SALT: &[u8] = b"FlowHub_LLM_Provider_Encryption_Salt_v1";
const ITERATIONS: u32 = 100_000;
const KEY_SIZE: usize = 32;
const NONCE_SIZE: usize = 12;

/// 从应用数据目录派生加密密钥
/// 使用目录路径作为密钥派生的额外熵源
pub fn derive_key(app_data_dir: &Path) -> Result<[u8; KEY_SIZE], String> {
    // 使用应用数据目录路径和固定 salt 派生密钥
    let path_bytes = app_data_dir.to_string_lossy().as_bytes().to_vec();

    // 组合路径和盐
    let mut combined = Vec::new();
    combined.extend_from_slice(&path_bytes);
    combined.extend_from_slice(SALT);

    // 使用 PBKDF2 派生密钥
    let mut key = [0u8; KEY_SIZE];
    pbkdf2_hmac::<Sha256>(&combined, SALT, ITERATIONS, &mut key);

    Ok(key)
}

/// 使用 AES-256-GCM 加密文本
pub fn encrypt(plaintext: &str, app_data_dir: &Path) -> Result<String, String> {
    if plaintext.is_empty() {
        return Ok(String::new());
    }

    let key = derive_key(app_data_dir)?;
    let cipher = Aes256Gcm::new_from_slice(&key)
        .map_err(|e| format!("Failed to create cipher: {}", e))?;

    // 生成随机 nonce
    let mut nonce_bytes = [0u8; NONCE_SIZE];
    rand::thread_rng().fill_bytes(&mut nonce_bytes);
    let nonce = Nonce::from_slice(&nonce_bytes);

    // 加密
    let ciphertext = cipher
        .encrypt(nonce, plaintext.as_bytes())
        .map_err(|e| format!("Encryption failed: {}", e))?;

    // 组合 nonce + ciphertext，并使用 base64 编码
    let mut result = Vec::new();
    result.extend_from_slice(&nonce_bytes);
    result.extend_from_slice(&ciphertext);

    Ok(base64::encode(&result))
}

/// 使用 AES-256-GCM 解密文本
pub fn decrypt(ciphertext_b64: &str, app_data_dir: &Path) -> Result<String, String> {
    if ciphertext_b64.is_empty() {
        return Ok(String::new());
    }

    let key = derive_key(app_data_dir)?;
    let cipher = Aes256Gcm::new_from_slice(&key)
        .map_err(|e| format!("Failed to create cipher: {}", e))?;

    // 解码 base64
    let ciphertext = base64::decode(ciphertext_b64)
        .map_err(|e| format!("Base64 decode failed: {}", e))?;

    if ciphertext.len() < NONCE_SIZE {
        return Err("Invalid ciphertext: too short".to_string());
    }

    // 分离 nonce 和密文
    let (nonce_bytes, encrypted_data) = ciphertext.split_at(NONCE_SIZE);
    let nonce = Nonce::from_slice(nonce_bytes);

    // 解密
    let plaintext = cipher
        .decrypt(nonce, encrypted_data)
        .map_err(|e| format!("Decryption failed: {}", e))?;

    String::from_utf8(plaintext)
        .map_err(|e| format!("Invalid UTF-8: {}", e))
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::env;

    #[test]
    fn test_encrypt_decrypt() {
        let temp_dir = env::temp_dir();
        let plaintext = "sk-test-api-key-12345";

        // 加密
        let encrypted = encrypt(plaintext, &temp_dir).unwrap();
        assert_ne!(encrypted, plaintext);

        // 解密
        let decrypted = decrypt(&encrypted, &temp_dir).unwrap();
        assert_eq!(decrypted, plaintext);
    }

    #[test]
    fn test_empty_string() {
        let temp_dir = env::temp_dir();

        let encrypted = encrypt("", &temp_dir).unwrap();
        assert!(encrypted.is_empty());

        let decrypted = decrypt("", &temp_dir).unwrap();
        assert!(decrypted.is_empty());
    }

    #[test]
    fn test_different_dirs_produce_different_keys() {
        let dir1 = Path::new("/path/to/app1");
        let dir2 = Path::new("/path/to/app2");

        let key1 = derive_key(dir1).unwrap();
        let key2 = derive_key(dir2).unwrap();

        assert_ne!(key1, key2);
    }
}
