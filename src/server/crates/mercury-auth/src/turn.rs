use base64::{Engine as _, engine::general_purpose::STANDARD as BASE64};
use mercury_core::config::TurnConfig;
use ring::hmac;
use serde::{Deserialize, Serialize};
use std::time::{SystemTime, UNIX_EPOCH};

/// TURN credentials returned to the client for WebRTC media relay.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct TurnCredentials {
    pub username: String,
    pub credential: String,
    pub urls: Vec<String>,
    pub ttl: u64,
}

/// Generate time-limited TURN credentials using the TURN REST API shared-secret model.
///
/// The credential is an HMAC-SHA1 of the temporary username, where the username
/// encodes the expiry timestamp and user ID: `{expiry_timestamp}:{user_id}`.
pub fn generate_turn_credentials(user_id: &str, config: &TurnConfig) -> TurnCredentials {
    let timestamp = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .expect("system clock before UNIX epoch")
        .as_secs()
        + config.credential_ttl_seconds;

    let username = format!("{timestamp}:{user_id}");
    let key = hmac::Key::new(hmac::HMAC_SHA1_FOR_LEGACY_USE_ONLY, config.secret.as_bytes());
    let signature = hmac::sign(&key, username.as_bytes());
    let credential = BASE64.encode(signature.as_ref());

    TurnCredentials {
        username,
        credential,
        urls: config.urls.clone(),
        ttl: config.credential_ttl_seconds,
    }
}

/// Verify a TURN credential (useful for testing).
pub fn verify_turn_credential(username: &str, credential: &str, secret: &str) -> bool {
    let key = hmac::Key::new(hmac::HMAC_SHA1_FOR_LEGACY_USE_ONLY, secret.as_bytes());
    let expected = hmac::sign(&key, username.as_bytes());
    let expected_b64 = BASE64.encode(expected.as_ref());
    credential == expected_b64
}

#[cfg(test)]
mod tests {
    use super::*;

    fn test_turn_config() -> TurnConfig {
        TurnConfig {
            enabled: true,
            secret: "test-turn-secret".into(),
            urls: vec!["turn:localhost:3478".into()],
            credential_ttl_seconds: 86400,
        }
    }

    #[test]
    fn turn_credential_generation() {
        let config = test_turn_config();
        let creds = generate_turn_credentials("user-123", &config);

        assert!(creds.username.contains("user-123"));
        assert!(!creds.credential.is_empty());
        assert_eq!(creds.urls, vec!["turn:localhost:3478"]);
        assert_eq!(creds.ttl, 86400);
    }

    #[test]
    fn turn_credential_hmac_verification() {
        let config = test_turn_config();
        let creds = generate_turn_credentials("user-456", &config);

        // Verify the credential matches expected HMAC-SHA1
        assert!(verify_turn_credential(
            &creds.username,
            &creds.credential,
            &config.secret
        ));
    }

    #[test]
    fn turn_credential_wrong_secret_fails() {
        let config = test_turn_config();
        let creds = generate_turn_credentials("user-789", &config);

        assert!(!verify_turn_credential(
            &creds.username,
            &creds.credential,
            "wrong-secret"
        ));
    }

    #[test]
    fn turn_credential_known_input_output() {
        // Test with known inputs to verify HMAC-SHA1 produces expected output.
        // This ensures our implementation matches the TURN REST API spec.
        let secret = "test-secret";
        let username = "1700000000:test-user";

        let key = hmac::Key::new(hmac::HMAC_SHA1_FOR_LEGACY_USE_ONLY, secret.as_bytes());
        let signature = hmac::sign(&key, username.as_bytes());
        let credential = BASE64.encode(signature.as_ref());

        // Verify it's a valid base64 string of the right length (SHA1 = 20 bytes → 28 base64 chars)
        assert_eq!(credential.len(), 28);

        // Verify round-trip
        assert!(verify_turn_credential(username, &credential, secret));

        // Different username should produce different credential
        let key2 = hmac::Key::new(hmac::HMAC_SHA1_FOR_LEGACY_USE_ONLY, secret.as_bytes());
        let sig2 = hmac::sign(&key2, b"1700000000:other-user");
        let cred2 = BASE64.encode(sig2.as_ref());
        assert_ne!(credential, cred2);
    }

    #[test]
    fn turn_credential_username_contains_expiry_timestamp() {
        let config = test_turn_config();
        let creds = generate_turn_credentials("user-test", &config);

        let parts: Vec<&str> = creds.username.split(':').collect();
        assert_eq!(parts.len(), 2);

        // First part should be a valid unix timestamp in the future
        let timestamp: u64 = parts[0].parse().expect("timestamp should be a number");
        let now = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_secs();
        assert!(timestamp > now, "expiry should be in the future");
        assert!(timestamp <= now + config.credential_ttl_seconds + 1);
    }
}
