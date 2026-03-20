use aes_gcm::{
    aead::{Aead, KeyInit},
    Aes256Gcm, Nonce,
};
use base64::{Engine as _, engine::general_purpose::STANDARD};
use pbkdf2::pbkdf2_hmac;
use rand::RngCore;
use sha2::Sha256;

/// Derived key from master password
#[derive(Clone)]
pub struct DerivedKey {
    pub key: [u8; 32],
    pub salt: [u8; 16],
}

/// Crypto manager for encryption/decryption
pub struct CryptoManager {
    key: [u8; 32],
    salt: [u8; 16],
}

impl CryptoManager {
    /// Create new crypto manager with master password
    pub fn new(master_password: &str) -> anyhow::Result<Self> {
        // Generate random salt
        let mut salt = [0u8; 16];
        rand::thread_rng().fill_bytes(&mut salt);

        // Derive key using PBKDF2
        let mut key = [0u8; 32];
        pbkdf2_hmac::<Sha256>(master_password.as_bytes(), &salt, 100_000, &mut key);

        Ok(Self { key, salt })
    }

    /// Create from existing salt (for decryption)
    pub fn from_salt(master_password: &str, salt: &[u8]) -> anyhow::Result<Self> {
        let mut key = [0u8; 32];
        pbkdf2_hmac::<Sha256>(master_password.as_bytes(), salt, 100_000, &mut key);

        let salt: [u8; 16] = salt.try_into().map_err(|_| anyhow::anyhow!("Invalid salt length"))?;

        Ok(Self { key, salt })
    }

    /// Encrypt plaintext
    pub fn encrypt(&self, plaintext: &str) -> anyhow::Result<String> {
        let cipher = Aes256Gcm::new_from_slice(&self.key)
            .map_err(|e| anyhow::anyhow!("Failed to create cipher: {:?}", e))?;

        // Generate random nonce
        let mut nonce_bytes = [0u8; 12];
        rand::thread_rng().fill_bytes(&mut nonce_bytes);
        let nonce = Nonce::from_slice(&nonce_bytes);

        // Encrypt
        let ciphertext = cipher
            .encrypt(nonce, plaintext.as_bytes())
            .map_err(|e| anyhow::anyhow!("Encryption failed: {:?}", e))?;

        // Combine: salt + nonce + ciphertext
        let mut result = Vec::new();
        result.extend_from_slice(&self.salt);
        result.extend_from_slice(&nonce_bytes);
        result.extend_from_slice(&ciphertext);

        // Base64 encode
        Ok(STANDARD.encode(&result))
    }

    /// Decrypt ciphertext
    pub fn decrypt(&self, ciphertext: &str) -> anyhow::Result<String> {
        // Base64 decode
        let data = STANDARD.decode(ciphertext)?;

        if data.len() < 28 {
            return Err(anyhow::anyhow!("Invalid ciphertext length"));
        }

        // Extract components
        let _salt = &data[0..16];  // salt is embedded but we use self.key directly
        let nonce_bytes = &data[16..28];
        let encrypted = &data[28..];

        // Use the stored key directly (already derived from master password + salt)
        let cipher = Aes256Gcm::new_from_slice(&self.key)
            .map_err(|e| anyhow::anyhow!("Failed to create cipher: {:?}", e))?;

        let nonce = Nonce::from_slice(nonce_bytes);

        // Decrypt
        let plaintext = cipher
            .decrypt(nonce, encrypted)
            .map_err(|e| anyhow::anyhow!("Decryption failed: {:?}", e))?;

        String::from_utf8(plaintext).map_err(|e| anyhow::anyhow!("Invalid UTF-8: {}", e))
    }

    /// Decrypt ciphertext using master password
    /// This method extracts the salt from the ciphertext and re-derives the key
    pub fn decrypt_with_password(ciphertext: &str, master_password: &str) -> anyhow::Result<String> {
        // Base64 decode
        let data = STANDARD.decode(ciphertext)?;

        if data.len() < 28 {
            return Err(anyhow::anyhow!("Invalid ciphertext length"));
        }

        // Extract components
        let salt = &data[0..16];
        let nonce_bytes = &data[16..28];
        let encrypted = &data[28..];

        // Derive key using the salt from the ciphertext
        let mut key = [0u8; 32];
        pbkdf2_hmac::<Sha256>(master_password.as_bytes(), salt, 100_000, &mut key);

        // Create cipher with derived key
        let cipher = Aes256Gcm::new_from_slice(&key)
            .map_err(|e| anyhow::anyhow!("Failed to create cipher: {:?}", e))?;

        let nonce = Nonce::from_slice(nonce_bytes);

        // Decrypt
        let plaintext = cipher
            .decrypt(nonce, encrypted)
            .map_err(|e| anyhow::anyhow!("Decryption failed: {:?}", e))?;

        String::from_utf8(plaintext).map_err(|e| anyhow::anyhow!("Invalid UTF-8: {}", e))
    }
}
