use mercury_core::ids::{DeviceId, UserId};
use mercury_core::models::{Device, DeviceIdentityKey, OneTimePrekey};
use sqlx::PgPool;

/// Maximum number of devices a single user can register.
pub const MAX_DEVICES_PER_USER: i64 = 20;

/// Maximum number of unused one-time prekeys per device.
pub const MAX_UNUSED_OTPS_PER_DEVICE: i64 = 1000;

// ── Device CRUD ───────────────────────────────────────────

pub async fn create_device(
    pool: &PgPool,
    id: DeviceId,
    user_id: UserId,
    device_name: &str,
) -> Result<Device, sqlx::Error> {
    sqlx::query_as::<_, Device>(
        r#"
        INSERT INTO devices (id, user_id, device_name)
        VALUES ($1, $2, $3)
        RETURNING *
        "#,
    )
    .bind(id)
    .bind(user_id)
    .bind(device_name)
    .fetch_one(pool)
    .await
}

pub async fn count_devices_for_user(
    pool: &PgPool,
    user_id: UserId,
) -> Result<i64, sqlx::Error> {
    let row: (i64,) = sqlx::query_as(
        "SELECT COUNT(*) FROM devices WHERE user_id = $1",
    )
    .bind(user_id)
    .fetch_one(pool)
    .await?;
    Ok(row.0)
}

pub async fn list_devices_for_user(
    pool: &PgPool,
    user_id: UserId,
) -> Result<Vec<Device>, sqlx::Error> {
    sqlx::query_as::<_, Device>(
        "SELECT * FROM devices WHERE user_id = $1 ORDER BY created_at ASC",
    )
    .bind(user_id)
    .fetch_all(pool)
    .await
}

pub async fn get_device(
    pool: &PgPool,
    device_id: DeviceId,
) -> Result<Option<Device>, sqlx::Error> {
    sqlx::query_as::<_, Device>("SELECT * FROM devices WHERE id = $1")
        .bind(device_id)
        .fetch_optional(pool)
        .await
}

/// Delete a device only if it belongs to the given user.
/// Returns true if a row was deleted, false if the device didn't exist
/// or belonged to another user.
pub async fn delete_device(
    pool: &PgPool,
    device_id: DeviceId,
    user_id: UserId,
) -> Result<bool, sqlx::Error> {
    let result = sqlx::query(
        "DELETE FROM devices WHERE id = $1 AND user_id = $2",
    )
    .bind(device_id)
    .bind(user_id)
    .execute(pool)
    .await?;
    Ok(result.rows_affected() > 0)
}

// ── Identity Keys (upsert) ───────────────────────────────

/// Upsert the identity key bundle for a device.
/// Accepts a generic executor so it can be called within a transaction.
pub async fn upsert_identity_keys<'e, E>(
    executor: E,
    device_id: DeviceId,
    user_id: UserId,
    identity_key: &[u8],
    signed_prekey: &[u8],
    signed_prekey_id: i32,
    prekey_signature: &[u8],
) -> Result<DeviceIdentityKey, sqlx::Error>
where
    E: sqlx::PgExecutor<'e>,
{
    sqlx::query_as::<_, DeviceIdentityKey>(
        r#"
        INSERT INTO device_identity_keys
            (device_id, user_id, identity_key, signed_prekey, signed_prekey_id, prekey_signature)
        VALUES ($1, $2, $3, $4, $5, $6)
        ON CONFLICT (device_id) DO UPDATE SET
            identity_key = EXCLUDED.identity_key,
            signed_prekey = EXCLUDED.signed_prekey,
            signed_prekey_id = EXCLUDED.signed_prekey_id,
            prekey_signature = EXCLUDED.prekey_signature,
            updated_at = now()
        RETURNING *
        "#,
    )
    .bind(device_id)
    .bind(user_id)
    .bind(identity_key)
    .bind(signed_prekey)
    .bind(signed_prekey_id)
    .bind(prekey_signature)
    .fetch_one(executor)
    .await
}

// ── One-Time Pre-Keys ────────────────────────────────────

/// Batch-insert one-time prekeys. Ignores duplicates (ON CONFLICT DO NOTHING)
/// so re-uploading the same batch is idempotent.
/// Accepts a generic executor so it can be called within a transaction.
pub async fn insert_one_time_prekeys<'e, E>(
    executor: E,
    device_id: DeviceId,
    user_id: UserId,
    keys: &[(i32, Vec<u8>)],
) -> Result<u64, sqlx::Error>
where
    E: sqlx::PgExecutor<'e>,
{
    if keys.is_empty() {
        return Ok(0);
    }

    // Build a batch insert with unnest for efficiency
    let key_ids: Vec<i32> = keys.iter().map(|(id, _)| *id).collect();
    let prekeys: Vec<Vec<u8>> = keys.iter().map(|(_, pk)| pk.clone()).collect();

    let result = sqlx::query(
        r#"
        INSERT INTO one_time_prekeys (device_id, user_id, key_id, prekey)
        SELECT $1, $2, unnest($3::int[]), unnest($4::bytea[])
        ON CONFLICT (device_id, key_id) DO NOTHING
        "#,
    )
    .bind(device_id)
    .bind(user_id)
    .bind(&key_ids)
    .bind(&prekeys)
    .execute(executor)
    .await?;

    Ok(result.rows_affected())
}

/// Atomically claim a single unused one-time prekey for the given device.
/// Uses FOR UPDATE SKIP LOCKED to avoid contention under concurrent claims.
/// Returns None if no unused OTPs remain.
pub async fn claim_one_time_prekey(
    pool: &PgPool,
    device_id: DeviceId,
) -> Result<Option<OneTimePrekey>, sqlx::Error> {
    sqlx::query_as::<_, OneTimePrekey>(
        r#"
        UPDATE one_time_prekeys
        SET used = TRUE
        WHERE id = (
            SELECT id FROM one_time_prekeys
            WHERE device_id = $1 AND used = FALSE
            ORDER BY key_id ASC
            LIMIT 1
            FOR UPDATE SKIP LOCKED
        )
        RETURNING *
        "#,
    )
    .bind(device_id)
    .fetch_optional(pool)
    .await
}

pub async fn count_unused_otps(
    pool: &PgPool,
    device_id: DeviceId,
) -> Result<i64, sqlx::Error> {
    let row: (i64,) = sqlx::query_as(
        "SELECT COUNT(*) FROM one_time_prekeys WHERE device_id = $1 AND used = FALSE",
    )
    .bind(device_id)
    .fetch_one(pool)
    .await?;
    Ok(row.0)
}

// ── Key Bundle Fetch ─────────────────────────────────────

pub async fn get_key_bundle(
    pool: &PgPool,
    device_id: DeviceId,
) -> Result<Option<DeviceIdentityKey>, sqlx::Error> {
    sqlx::query_as::<_, DeviceIdentityKey>(
        "SELECT * FROM device_identity_keys WHERE device_id = $1",
    )
    .bind(device_id)
    .fetch_optional(pool)
    .await
}

/// Fetch all device key bundles for a user, joining devices + device_identity_keys.
pub async fn get_key_bundles_for_user(
    pool: &PgPool,
    user_id: UserId,
) -> Result<Vec<(Device, DeviceIdentityKey)>, sqlx::Error> {
    // sqlx doesn't natively support mapping to a tuple of two FromRow types,
    // so we use a flat struct and split manually.
    let rows = sqlx::query_as::<_, DeviceBundleRow>(
        r#"
        SELECT
            d.id AS device_id,
            d.user_id,
            d.device_name,
            d.created_at AS device_created_at,
            d.last_seen_at,
            dik.identity_key,
            dik.signed_prekey,
            dik.signed_prekey_id,
            dik.prekey_signature,
            dik.updated_at AS keys_updated_at
        FROM devices d
        INNER JOIN device_identity_keys dik ON d.id = dik.device_id
        WHERE d.user_id = $1
        ORDER BY d.created_at ASC
        "#,
    )
    .bind(user_id)
    .fetch_all(pool)
    .await?;

    Ok(rows
        .into_iter()
        .map(|r| {
            let device = Device {
                id: r.device_id,
                user_id: r.user_id,
                device_name: r.device_name,
                created_at: r.device_created_at,
                last_seen_at: r.last_seen_at,
            };
            let keys = DeviceIdentityKey {
                device_id: r.device_id,
                user_id: r.user_id,
                identity_key: r.identity_key,
                signed_prekey: r.signed_prekey,
                signed_prekey_id: r.signed_prekey_id,
                prekey_signature: r.prekey_signature,
                updated_at: r.keys_updated_at,
            };
            (device, keys)
        })
        .collect())
}

/// Check if a user exists in the database.
pub async fn user_exists(pool: &PgPool, user_id: UserId) -> Result<bool, sqlx::Error> {
    let row: (bool,) =
        sqlx::query_as("SELECT EXISTS(SELECT 1 FROM users WHERE id = $1)")
            .bind(user_id)
            .fetch_one(pool)
            .await?;
    Ok(row.0)
}

// ── Internal helper struct for the join query ────────────

#[derive(sqlx::FromRow)]
struct DeviceBundleRow {
    device_id: DeviceId,
    user_id: UserId,
    device_name: String,
    device_created_at: Option<chrono::DateTime<chrono::Utc>>,
    last_seen_at: Option<chrono::DateTime<chrono::Utc>>,
    identity_key: Vec<u8>,
    signed_prekey: Vec<u8>,
    signed_prekey_id: i32,
    prekey_signature: Vec<u8>,
    keys_updated_at: Option<chrono::DateTime<chrono::Utc>>,
}
