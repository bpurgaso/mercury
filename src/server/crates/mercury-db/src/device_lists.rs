use mercury_core::ids::UserId;
use mercury_core::models::{DeviceList, KeyBackup};
use sqlx::PgPool;

// ── Device Lists ─────────────────────────────────────────

/// Fetch the existing device list for a user (if any).
pub async fn get_device_list(
    pool: &PgPool,
    user_id: UserId,
) -> Result<Option<DeviceList>, sqlx::Error> {
    sqlx::query_as::<_, DeviceList>(
        "SELECT * FROM device_lists WHERE user_id = $1",
    )
    .bind(user_id)
    .fetch_optional(pool)
    .await
}

/// Upsert a signed device list. On conflict (same user), updates the
/// signed_list, signature, and timestamp but leaves master_verify_key
/// unchanged (TOFU enforcement happens in the handler layer).
pub async fn upsert_device_list(
    pool: &PgPool,
    user_id: UserId,
    signed_list: &[u8],
    master_verify_key: &[u8],
    signature: &[u8],
) -> Result<DeviceList, sqlx::Error> {
    sqlx::query_as::<_, DeviceList>(
        r#"
        INSERT INTO device_lists (user_id, signed_list, master_verify_key, signature)
        VALUES ($1, $2, $3, $4)
        ON CONFLICT (user_id) DO UPDATE SET
            signed_list = EXCLUDED.signed_list,
            signature = EXCLUDED.signature,
            updated_at = now()
        RETURNING *
        "#,
    )
    .bind(user_id)
    .bind(signed_list)
    .bind(master_verify_key)
    .bind(signature)
    .fetch_one(pool)
    .await
}

// ── Key Backups ──────────────────────────────────────────

/// Fetch the key backup for a user (if any).
pub async fn get_key_backup(
    pool: &PgPool,
    user_id: UserId,
) -> Result<Option<KeyBackup>, sqlx::Error> {
    sqlx::query_as::<_, KeyBackup>(
        "SELECT * FROM key_backups WHERE user_id = $1",
    )
    .bind(user_id)
    .fetch_optional(pool)
    .await
}

/// Upsert a key backup. On first insert, backup_version = 1.
/// On subsequent upserts, backup_version is incremented.
pub async fn upsert_key_backup(
    pool: &PgPool,
    user_id: UserId,
    encrypted_backup: &[u8],
    key_derivation_salt: &[u8],
) -> Result<KeyBackup, sqlx::Error> {
    sqlx::query_as::<_, KeyBackup>(
        r#"
        INSERT INTO key_backups (user_id, encrypted_backup, key_derivation_salt)
        VALUES ($1, $2, $3)
        ON CONFLICT (user_id) DO UPDATE SET
            encrypted_backup = EXCLUDED.encrypted_backup,
            key_derivation_salt = EXCLUDED.key_derivation_salt,
            backup_version = key_backups.backup_version + 1,
            updated_at = now()
        RETURNING *
        "#,
    )
    .bind(user_id)
    .bind(encrypted_backup)
    .bind(key_derivation_salt)
    .fetch_one(pool)
    .await
}

/// Delete a user's key backup. Returns true if a row was deleted.
pub async fn delete_key_backup(
    pool: &PgPool,
    user_id: UserId,
) -> Result<bool, sqlx::Error> {
    let result = sqlx::query("DELETE FROM key_backups WHERE user_id = $1")
        .bind(user_id)
        .execute(pool)
        .await?;
    Ok(result.rows_affected() > 0)
}
