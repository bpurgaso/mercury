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
