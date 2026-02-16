use chrono::{Duration, Utc};
use jsonwebtoken::{DecodingKey, EncodingKey, Header, TokenData, Validation};
use mercury_core::config::AuthConfig;
use mercury_core::ids::UserId;
use serde::{Deserialize, Serialize};
use uuid::Uuid;

/// JWT claims included in both access and refresh tokens.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Claims {
    /// Subject — the user ID
    pub sub: String,
    /// JWT ID — unique identifier for this token, used as Redis session key
    pub jti: String,
    /// Token type: "access" or "refresh"
    pub token_type: String,
    /// Issued at (Unix timestamp)
    pub iat: i64,
    /// Expiration (Unix timestamp)
    pub exp: i64,
}

/// Result of generating a token pair after login/register.
#[derive(Debug, Serialize, Deserialize)]
pub struct TokenPair {
    pub access_token: String,
    pub refresh_token: String,
    pub access_token_jti: String,
    pub refresh_token_jti: String,
    /// Access token expiry as Unix timestamp
    pub access_token_exp: i64,
    /// Refresh token expiry as Unix timestamp
    pub refresh_token_exp: i64,
    /// Access token expiry as seconds from now
    pub expires_in: u64,
}

/// Generate a JWT access token.
pub fn create_access_token(config: &AuthConfig, user_id: UserId) -> Result<(String, Claims), jsonwebtoken::errors::Error> {
    let now = Utc::now();
    let exp = now + Duration::minutes(config.jwt_expiry_minutes as i64);
    let jti = Uuid::now_v7().to_string();

    let claims = Claims {
        sub: user_id.0.to_string(),
        jti,
        token_type: "access".to_string(),
        iat: now.timestamp(),
        exp: exp.timestamp(),
    };

    let token = jsonwebtoken::encode(
        &Header::default(),
        &claims,
        &EncodingKey::from_secret(config.jwt_secret.as_bytes()),
    )?;

    Ok((token, claims))
}

/// Generate a JWT refresh token.
pub fn create_refresh_token(config: &AuthConfig, user_id: UserId) -> Result<(String, Claims), jsonwebtoken::errors::Error> {
    let now = Utc::now();
    let exp = now + Duration::days(config.refresh_token_expiry_days as i64);
    let jti = Uuid::now_v7().to_string();

    let claims = Claims {
        sub: user_id.0.to_string(),
        jti,
        token_type: "refresh".to_string(),
        iat: now.timestamp(),
        exp: exp.timestamp(),
    };

    let token = jsonwebtoken::encode(
        &Header::default(),
        &claims,
        &EncodingKey::from_secret(config.jwt_secret.as_bytes()),
    )?;

    Ok((token, claims))
}

/// Generate an access + refresh token pair.
pub fn create_token_pair(config: &AuthConfig, user_id: UserId) -> Result<TokenPair, jsonwebtoken::errors::Error> {
    let (access_token, access_claims) = create_access_token(config, user_id)?;
    let (refresh_token, refresh_claims) = create_refresh_token(config, user_id)?;

    Ok(TokenPair {
        access_token,
        refresh_token,
        access_token_jti: access_claims.jti,
        refresh_token_jti: refresh_claims.jti,
        access_token_exp: access_claims.exp,
        refresh_token_exp: refresh_claims.exp,
        expires_in: config.jwt_expiry_minutes * 60,
    })
}

/// Validate and decode a JWT token.
pub fn validate_token(config: &AuthConfig, token: &str) -> Result<TokenData<Claims>, jsonwebtoken::errors::Error> {
    let mut validation = Validation::default();
    validation.validate_exp = true;
    validation.required_spec_claims = ["sub", "exp", "jti"].iter().map(|s| s.to_string()).collect();

    jsonwebtoken::decode::<Claims>(
        token,
        &DecodingKey::from_secret(config.jwt_secret.as_bytes()),
        &validation,
    )
}

/// Extract UserId from validated claims.
pub fn user_id_from_claims(claims: &Claims) -> Result<UserId, uuid::Error> {
    let uuid = Uuid::parse_str(&claims.sub)?;
    Ok(UserId(uuid))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn test_config() -> AuthConfig {
        AuthConfig {
            jwt_secret: "test-jwt-secret-key-for-testing".into(),
            jwt_expiry_minutes: 60,
            refresh_token_expiry_days: 30,
            argon2_memory_kib: 65536,
            argon2_iterations: 3,
            argon2_parallelism: 4,
        }
    }

    #[test]
    fn jwt_encode_decode_roundtrip() {
        let config = test_config();
        let user_id = UserId::new();

        let (token, original_claims) = create_access_token(&config, user_id).expect("should create token");
        let decoded = validate_token(&config, &token).expect("should validate token");

        assert_eq!(decoded.claims.sub, user_id.0.to_string());
        assert_eq!(decoded.claims.jti, original_claims.jti);
        assert_eq!(decoded.claims.token_type, "access");
    }

    #[test]
    fn jwt_refresh_token_encode_decode() {
        let config = test_config();
        let user_id = UserId::new();

        let (token, _claims) = create_refresh_token(&config, user_id).expect("should create token");
        let decoded = validate_token(&config, &token).expect("should validate token");

        assert_eq!(decoded.claims.sub, user_id.0.to_string());
        assert_eq!(decoded.claims.token_type, "refresh");
    }

    #[test]
    fn jwt_token_pair_has_unique_jtis() {
        let config = test_config();
        let user_id = UserId::new();

        let pair = create_token_pair(&config, user_id).expect("should create pair");
        assert_ne!(pair.access_token_jti, pair.refresh_token_jti);
        assert_ne!(pair.access_token, pair.refresh_token);
    }

    #[test]
    fn jwt_invalid_secret_rejected() {
        let config = test_config();
        let user_id = UserId::new();

        let (token, _) = create_access_token(&config, user_id).expect("should create token");

        let bad_config = AuthConfig {
            jwt_secret: "wrong-secret".into(),
            ..test_config()
        };
        let result = validate_token(&bad_config, &token);
        assert!(result.is_err());
    }

    #[test]
    fn jwt_expired_token_rejected() {
        let config = test_config();
        let user_id = UserId::new();

        // Create a token that expired well in the past (> 60s leeway)
        let now = Utc::now();
        let exp = now - Duration::seconds(120);
        let claims = Claims {
            sub: user_id.0.to_string(),
            jti: Uuid::now_v7().to_string(),
            token_type: "access".to_string(),
            iat: (now - Duration::hours(2)).timestamp(),
            exp: exp.timestamp(),
        };

        let token = jsonwebtoken::encode(
            &Header::default(),
            &claims,
            &EncodingKey::from_secret(config.jwt_secret.as_bytes()),
        )
        .expect("should encode");

        let result = validate_token(&config, &token);
        assert!(result.is_err(), "expired token should be rejected");
    }

    #[test]
    fn jwt_garbage_token_rejected() {
        let config = test_config();
        let result = validate_token(&config, "garbage.token.value");
        assert!(result.is_err());
    }

    #[test]
    fn jwt_user_id_extraction() {
        let config = test_config();
        let user_id = UserId::new();

        let (token, _) = create_access_token(&config, user_id).expect("should create token");
        let decoded = validate_token(&config, &token).expect("should validate token");
        let extracted = user_id_from_claims(&decoded.claims).expect("should extract user_id");

        assert_eq!(extracted, user_id);
    }

    #[test]
    fn jwt_access_token_expiry_is_correct() {
        let config = test_config();
        let user_id = UserId::new();

        let (_, claims) = create_access_token(&config, user_id).expect("should create token");
        let expected_duration = config.jwt_expiry_minutes as i64 * 60;
        let actual_duration = claims.exp - claims.iat;

        // Allow 1 second tolerance for test execution time
        assert!((actual_duration - expected_duration).abs() <= 1);
    }

    #[test]
    fn jwt_refresh_token_expiry_is_correct() {
        let config = test_config();
        let user_id = UserId::new();

        let (_, claims) = create_refresh_token(&config, user_id).expect("should create token");
        let expected_duration = config.refresh_token_expiry_days as i64 * 86400;
        let actual_duration = claims.exp - claims.iat;

        // Allow 1 second tolerance
        assert!((actual_duration - expected_duration).abs() <= 1);
    }
}
