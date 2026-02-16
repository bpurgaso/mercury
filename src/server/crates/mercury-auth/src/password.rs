use argon2::{
    password_hash::{rand_core::OsRng, PasswordHash, PasswordHasher, PasswordVerifier, SaltString},
    Algorithm, Argon2, Params, Version,
};
use mercury_core::config::AuthConfig;

/// Build an Argon2id hasher from the application's auth configuration.
pub fn build_argon2(config: &AuthConfig) -> Argon2<'_> {
    let params = Params::new(
        config.argon2_memory_kib,
        config.argon2_iterations,
        config.argon2_parallelism,
        None, // default output length (32 bytes)
    )
    .expect("invalid Argon2 parameters");

    Argon2::new(Algorithm::Argon2id, Version::V0x13, params)
}

/// Hash a password using Argon2id with the configured parameters.
pub fn hash_password(config: &AuthConfig, password: &str) -> Result<String, argon2::password_hash::Error> {
    let salt = SaltString::generate(&mut OsRng);
    let argon2 = build_argon2(config);
    let hash = argon2.hash_password(password.as_bytes(), &salt)?;
    Ok(hash.to_string())
}

/// Verify a password against an Argon2id hash.
pub fn verify_password(config: &AuthConfig, password: &str, hash: &str) -> Result<bool, argon2::password_hash::Error> {
    let parsed_hash = PasswordHash::new(hash)?;
    let argon2 = build_argon2(config);
    match argon2.verify_password(password.as_bytes(), &parsed_hash) {
        Ok(()) => Ok(true),
        Err(argon2::password_hash::Error::Password) => Ok(false),
        Err(e) => Err(e),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn test_config() -> AuthConfig {
        AuthConfig {
            jwt_secret: "test-secret".into(),
            jwt_expiry_minutes: 60,
            refresh_token_expiry_days: 30,
            argon2_memory_kib: 65536,
            argon2_iterations: 3,
            argon2_parallelism: 4,
        }
    }

    #[test]
    fn password_hash_roundtrip() {
        let config = test_config();
        let password = "SecureP@ss1";
        let hash = hash_password(&config, password).expect("hash should succeed");

        // Hash should be a valid Argon2id string
        assert!(hash.starts_with("$argon2id$"));

        // Correct password should verify
        assert!(verify_password(&config, password, &hash).expect("verify should succeed"));

        // Wrong password should not verify
        assert!(!verify_password(&config, "WrongPassword", &hash).expect("verify should succeed"));
    }

    #[test]
    fn password_hash_uses_configured_params() {
        let config = test_config();
        let hash = hash_password(&config, "test").expect("hash should succeed");

        // Parse the hash and verify Argon2id parameters
        let parsed = PasswordHash::new(&hash).expect("should parse hash");
        assert_eq!(parsed.algorithm, argon2::ARGON2ID_IDENT);

        // Verify the params are what we configured
        let params = parsed.params;
        let m = params.get_str("m").expect("should have m param");
        assert_eq!(m, "65536");
        let t = params.get_str("t").expect("should have t param");
        assert_eq!(t, "3");
        let p = params.get_str("p").expect("should have p param");
        assert_eq!(p, "4");
    }

    #[test]
    fn different_passwords_produce_different_hashes() {
        let config = test_config();
        let hash1 = hash_password(&config, "password1").expect("hash should succeed");
        let hash2 = hash_password(&config, "password2").expect("hash should succeed");
        assert_ne!(hash1, hash2);
    }

    #[test]
    fn same_password_produces_different_hashes_due_to_salt() {
        let config = test_config();
        let hash1 = hash_password(&config, "same_password").expect("hash should succeed");
        let hash2 = hash_password(&config, "same_password").expect("hash should succeed");
        assert_ne!(hash1, hash2); // Different salt each time
    }
}
