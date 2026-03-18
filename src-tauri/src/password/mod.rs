use std::sync::{Arc, Mutex};

mod crypto;

pub use crypto::{CryptoManager, DerivedKey};

/// Password entry
#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
pub struct PasswordEntry {
    pub id: i64,
    pub title: String,
    pub username: Option<String>,
    pub password: String,
    pub url: Option<String>,
    pub notes: Option<String>,
    pub category_id: Option<i64>,
    pub favorite: bool,
    pub created_at: String,
    pub updated_at: String,
}

/// Password category
#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
pub struct PasswordCategory {
    pub id: i64,
    pub name: String,
    pub icon: String,
    pub color: String,
}

/// Password manager state
pub struct PasswordManager {
    crypto: Arc<Mutex<Option<CryptoManager>>>,
    master_key: Arc<Mutex<Option<DerivedKey>>>,
    master_password: Arc<Mutex<Option<String>>>,
}

impl PasswordManager {
    pub fn new() -> Self {
        Self {
            crypto: Arc::new(Mutex::new(None)),
            master_key: Arc::new(Mutex::new(None)),
            master_password: Arc::new(Mutex::new(None)),
        }
    }

    /// Initialize with master password
    pub fn unlock(&self, master_password: &str) -> anyhow::Result<()> {
        let crypto = CryptoManager::new(master_password)?;

        let mut crypto_guard = self.crypto.lock().map_err(|e| anyhow::anyhow!("Lock error: {}", e))?;
        *crypto_guard = Some(crypto);

        // Store master password for decryption
        let mut password_guard = self.master_password.lock().map_err(|e| anyhow::anyhow!("Lock error: {}", e))?;
        *password_guard = Some(master_password.to_string());

        Ok(())
    }

    /// Lock the password manager
    pub fn lock(&self) {
        if let Ok(mut crypto) = self.crypto.lock() {
            *crypto = None;
        }
        if let Ok(mut key) = self.master_key.lock() {
            *key = None;
        }
        if let Ok(mut password) = self.master_password.lock() {
            *password = None;
        }
    }

    /// Check if unlocked
    pub fn is_unlocked(&self) -> bool {
        self.crypto
            .lock()
            .map(|c| c.is_some())
            .unwrap_or(false)
    }

    /// Encrypt password
    pub fn encrypt_password(&self, plaintext: &str) -> anyhow::Result<String> {
        let crypto = self
            .crypto
            .lock()
            .map_err(|e| anyhow::anyhow!("Lock error: {}", e))?;

        let crypto = crypto.as_ref().ok_or_else(|| anyhow::anyhow!("Not unlocked"))?;
        crypto.encrypt(plaintext)
    }

    /// Decrypt password
    pub fn decrypt_password(&self, ciphertext: &str) -> anyhow::Result<String> {
        let master_password = self
            .master_password
            .lock()
            .map_err(|e| anyhow::anyhow!("Lock error: {}", e))?
            .as_ref()
            .ok_or_else(|| anyhow::anyhow!("Not unlocked"))?
            .clone();

        CryptoManager::decrypt_with_password(ciphertext, &master_password)
    }

    /// Change master password
    pub fn change_master_password(
        &self,
        old_password: &str,
        new_password: &str,
    ) -> anyhow::Result<()> {
        // Verify old password works
        let _old_crypto = CryptoManager::new(old_password)?;

        // Create new crypto with new password
        let new_crypto = CryptoManager::new(new_password)?;

        // Update stored crypto
        let mut crypto_guard = self.crypto.lock().map_err(|e| anyhow::anyhow!("Lock error: {}", e))?;
        *crypto_guard = Some(new_crypto);

        Ok(())
    }
}

impl Default for PasswordManager {
    fn default() -> Self {
        Self::new()
    }
}

pub struct PasswordManagerState(pub Arc<PasswordManager>);
