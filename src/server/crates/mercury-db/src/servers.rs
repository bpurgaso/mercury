use mercury_core::ids::{ServerId, UserId};
use mercury_core::models::{Server, ServerMember};
use sqlx::PgPool;

pub async fn create_server(
    pool: &PgPool,
    id: ServerId,
    name: &str,
    owner_id: UserId,
    invite_code: &str,
) -> Result<Server, sqlx::Error> {
    sqlx::query_as::<_, Server>(
        r#"
        INSERT INTO servers (id, name, owner_id, invite_code)
        VALUES ($1, $2, $3, $4)
        RETURNING *
        "#,
    )
    .bind(id)
    .bind(name)
    .bind(owner_id)
    .bind(invite_code)
    .fetch_one(pool)
    .await
}

pub async fn get_server_by_id(
    pool: &PgPool,
    id: ServerId,
) -> Result<Option<Server>, sqlx::Error> {
    sqlx::query_as::<_, Server>("SELECT * FROM servers WHERE id = $1")
        .bind(id)
        .fetch_optional(pool)
        .await
}

pub async fn get_server_by_invite_code(
    pool: &PgPool,
    invite_code: &str,
) -> Result<Option<Server>, sqlx::Error> {
    sqlx::query_as::<_, Server>("SELECT * FROM servers WHERE invite_code = $1")
        .bind(invite_code)
        .fetch_optional(pool)
        .await
}

pub async fn list_servers_for_user(
    pool: &PgPool,
    user_id: UserId,
) -> Result<Vec<Server>, sqlx::Error> {
    sqlx::query_as::<_, Server>(
        r#"
        SELECT s.* FROM servers s
        INNER JOIN server_members sm ON s.id = sm.server_id
        WHERE sm.user_id = $1
        ORDER BY s.created_at DESC
        "#,
    )
    .bind(user_id)
    .fetch_all(pool)
    .await
}

pub async fn delete_server(pool: &PgPool, id: ServerId) -> Result<bool, sqlx::Error> {
    let result = sqlx::query("DELETE FROM servers WHERE id = $1")
        .bind(id)
        .execute(pool)
        .await?;
    Ok(result.rows_affected() > 0)
}

pub async fn update_server(
    pool: &PgPool,
    id: ServerId,
    name: Option<&str>,
    description: Option<&str>,
    icon_url: Option<&str>,
) -> Result<Option<Server>, sqlx::Error> {
    sqlx::query_as::<_, Server>(
        r#"
        UPDATE servers SET
            name = COALESCE($2, name),
            description = COALESCE($3, description),
            icon_url = COALESCE($4, icon_url)
        WHERE id = $1
        RETURNING *
        "#,
    )
    .bind(id)
    .bind(name)
    .bind(description)
    .bind(icon_url)
    .fetch_optional(pool)
    .await
}

pub async fn add_member(
    pool: &PgPool,
    user_id: UserId,
    server_id: ServerId,
) -> Result<ServerMember, sqlx::Error> {
    sqlx::query_as::<_, ServerMember>(
        r#"
        INSERT INTO server_members (user_id, server_id)
        VALUES ($1, $2)
        RETURNING *
        "#,
    )
    .bind(user_id)
    .bind(server_id)
    .fetch_one(pool)
    .await
}

pub async fn remove_member(
    pool: &PgPool,
    user_id: UserId,
    server_id: ServerId,
) -> Result<bool, sqlx::Error> {
    let result = sqlx::query("DELETE FROM server_members WHERE user_id = $1 AND server_id = $2")
        .bind(user_id)
        .bind(server_id)
        .execute(pool)
        .await?;
    Ok(result.rows_affected() > 0)
}

pub async fn is_member(
    pool: &PgPool,
    user_id: UserId,
    server_id: ServerId,
) -> Result<bool, sqlx::Error> {
    let row: Option<(i32,)> = sqlx::query_as(
        "SELECT 1 as n FROM server_members WHERE user_id = $1 AND server_id = $2",
    )
    .bind(user_id)
    .bind(server_id)
    .fetch_optional(pool)
    .await?;
    Ok(row.is_some())
}

pub async fn get_member_user_ids(
    pool: &PgPool,
    server_id: ServerId,
) -> Result<Vec<UserId>, sqlx::Error> {
    let rows: Vec<(UserId,)> =
        sqlx::query_as("SELECT user_id FROM server_members WHERE server_id = $1")
            .bind(server_id)
            .fetch_all(pool)
            .await?;
    Ok(rows.into_iter().map(|(id,)| id).collect())
}

/// Get the server_id for a channel (used for ownership/membership checks on channel routes).
pub async fn get_server_id_for_channel(
    pool: &PgPool,
    channel_id: mercury_core::ids::ChannelId,
) -> Result<Option<ServerId>, sqlx::Error> {
    let row: Option<(ServerId,)> =
        sqlx::query_as("SELECT server_id FROM channels WHERE id = $1")
            .bind(channel_id)
            .fetch_optional(pool)
            .await?;
    Ok(row.map(|(id,)| id))
}
