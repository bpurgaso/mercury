//! Background task that runs every 30 seconds, evaluates abuse thresholds
//! against Redis counters, and creates abuse_signals when thresholds are exceeded.

use fred::prelude::*;
use mercury_core::ids::UserId;
use mercury_moderation::SYSTEM_MODERATOR_ID;

use crate::state::AppState;
use crate::ws::protocol::{ServerEvent, ServerMessage};

/// Spawn the abuse detector background task.
pub fn spawn_abuse_detector(state: AppState) {
    tokio::spawn(async move {
        let mut interval = tokio::time::interval(std::time::Duration::from_secs(30));
        loop {
            interval.tick().await;
            if let Err(e) = run_detection_cycle(&state).await {
                tracing::warn!("abuse detector cycle error: {e}");
            }
        }
    });
}

async fn run_detection_cycle(state: &AppState) -> Result<(), anyhow::Error> {
    let config = &state.moderation_config.auto_actions;
    if !config.enabled {
        return Ok(());
    }

    // Scan users with active WebSocket sessions
    let connected_users = state.ws_manager.connected_user_ids();

    for user_id in connected_users {
        // Check rapid messaging threshold
        let msg_rate = mercury_moderation::abuse::get_msg_rate(&state.redis, user_id).await;
        if msg_rate > config.rapid_messaging_threshold {
            handle_rapid_messaging(state, user_id, msg_rate).await;
        }

        // Check mass DM threshold
        let dm_rate = mercury_moderation::abuse::get_dm_rate(&state.redis, user_id).await;
        if dm_rate > config.mass_dm_threshold {
            handle_mass_dm(state, user_id, dm_rate).await;
        }

        // Check join spam threshold
        let join_rate = mercury_moderation::abuse::get_join_rate(&state.redis, user_id).await;
        if join_rate > config.join_spam_threshold {
            handle_join_spam(state, user_id, join_rate).await;
        }

        // Check report threshold
        let report_count =
            mercury_moderation::abuse::get_report_count(&state.redis, user_id).await;
        if report_count > config.report_alert_threshold {
            handle_report_threshold(state, user_id, report_count).await;
        }
    }

    // Coordinated join detection
    check_coordinated_joins(state).await;

    Ok(())
}

async fn handle_rapid_messaging(state: &AppState, user_id: UserId, count: u64) {
    let config = &state.moderation_config.auto_actions;

    // Check if we already have a recent unreviewed signal for this user+type
    // to avoid duplicate signals every 30s. Use a Redis key as a dedup marker.
    let dedup_key = format!("abuse:signal_dedup:rapid_messaging:{}", user_id);
    let existing: Option<String> = state.redis.get(&dedup_key).await.unwrap_or(None);
    if existing.is_some() {
        return;
    }

    let signal = mercury_moderation::abuse::create_signal(
        &state.db,
        user_id,
        "rapid_messaging",
        "medium",
        serde_json::json!({ "msg_count_per_min": count }),
        Some("rate_limit"),
    )
    .await;

    if let Ok(signal) = signal {
        // Apply auto-action: temporary rate limit
        mercury_moderation::abuse::apply_rate_limit(
            &state.redis,
            user_id,
            config.rapid_messaging_cooldown_seconds as i64,
        )
        .await;

        // Set dedup marker (expires after cooldown)
        let _: () = state
            .redis
            .set(
                &dedup_key,
                "1",
                Some(fred::prelude::Expiration::EX(
                    config.rapid_messaging_cooldown_seconds as i64,
                )),
                None,
                false,
            )
            .await
            .unwrap_or(());

        // Log to audit (using system sentinel as moderator)
        log_auto_action(state, user_id, "rapid_messaging", &signal).await;

        // Send ABUSE_SIGNAL event to moderators
        send_abuse_signal_event(state, &signal).await;
    }
}

async fn handle_mass_dm(state: &AppState, user_id: UserId, count: u64) {
    let config = &state.moderation_config.auto_actions;

    let dedup_key = format!("abuse:signal_dedup:mass_dm:{}", user_id);
    let existing: Option<String> = state.redis.get(&dedup_key).await.unwrap_or(None);
    if existing.is_some() {
        return;
    }

    let signal = mercury_moderation::abuse::create_signal(
        &state.db,
        user_id,
        "mass_dm",
        "medium",
        serde_json::json!({ "dm_count_per_hour": count }),
        Some("dm_block"),
    )
    .await;

    if let Ok(signal) = signal {
        mercury_moderation::abuse::block_dm_creation(
            &state.redis,
            user_id,
            config.mass_dm_cooldown_seconds as i64,
        )
        .await;

        let _: () = state
            .redis
            .set(
                &dedup_key,
                "1",
                Some(fred::prelude::Expiration::EX(
                    config.mass_dm_cooldown_seconds as i64,
                )),
                None,
                false,
            )
            .await
            .unwrap_or(());

        log_auto_action(state, user_id, "mass_dm", &signal).await;
        send_abuse_signal_event(state, &signal).await;
    }
}

async fn handle_join_spam(state: &AppState, user_id: UserId, count: u64) {
    let config = &state.moderation_config.auto_actions;

    let dedup_key = format!("abuse:signal_dedup:join_spam:{}", user_id);
    let existing: Option<String> = state.redis.get(&dedup_key).await.unwrap_or(None);
    if existing.is_some() {
        return;
    }

    let signal = mercury_moderation::abuse::create_signal(
        &state.db,
        user_id,
        "join_spam",
        "medium",
        serde_json::json!({ "join_count_per_hour": count }),
        Some("join_block"),
    )
    .await;

    if let Ok(signal) = signal {
        mercury_moderation::abuse::block_joins(
            &state.redis,
            user_id,
            config.join_spam_cooldown_seconds as i64,
        )
        .await;

        let _: () = state
            .redis
            .set(
                &dedup_key,
                "1",
                Some(fred::prelude::Expiration::EX(
                    config.join_spam_cooldown_seconds as i64,
                )),
                None,
                false,
            )
            .await
            .unwrap_or(());

        log_auto_action(state, user_id, "join_spam", &signal).await;
        send_abuse_signal_event(state, &signal).await;
    }
}

async fn handle_report_threshold(state: &AppState, user_id: UserId, count: u64) {
    let dedup_key = format!("abuse:signal_dedup:report_threshold:{}", user_id);
    let existing: Option<String> = state.redis.get(&dedup_key).await.unwrap_or(None);
    if existing.is_some() {
        return;
    }

    let signal = mercury_moderation::abuse::create_signal(
        &state.db,
        user_id,
        "report_threshold",
        "high",
        serde_json::json!({ "report_count_per_day": count }),
        None, // No auto-action — just flag for operator review
    )
    .await;

    if let Ok(signal) = signal {
        // Dedup for 24 hours
        let _: () = state
            .redis
            .set(
                &dedup_key,
                "1",
                Some(fred::prelude::Expiration::EX(86400)),
                None,
                false,
            )
            .await
            .unwrap_or(());

        log_auto_action(state, user_id, "report_threshold", &signal).await;
        send_abuse_signal_event(state, &signal).await;
    }
}

/// Check for coordinated joins: >10 accounts with <24h age joining the same server within 5 min.
async fn check_coordinated_joins(state: &AppState) {
    let rows: Vec<(mercury_core::ids::ServerId, i64)> = sqlx::query_as(
        r#"
        SELECT sm.server_id, COUNT(*) as cnt
        FROM server_members sm
        JOIN users u ON u.id = sm.user_id
        WHERE sm.joined_at > now() - interval '5 minutes'
          AND u.created_at > now() - interval '24 hours'
        GROUP BY sm.server_id
        HAVING COUNT(*) > 10
        "#,
    )
    .fetch_all(&state.db)
    .await
    .unwrap_or_default();

    for (server_id, count) in rows {
        let dedup_key = format!("abuse:signal_dedup:coordinated_join:{}", server_id);
        let existing: Option<String> = state.redis.get(&dedup_key).await.unwrap_or(None);
        if existing.is_some() {
            continue;
        }

        // Get the server owner as the "target" for the signal
        if let Ok(Some(server)) =
            mercury_db::servers::get_server_by_id(&state.db, server_id).await
        {
            let _ = mercury_moderation::abuse::create_signal(
                &state.db,
                server.owner_id,
                "coordinated_join",
                "high",
                serde_json::json!({
                    "server_id": server_id.to_string(),
                    "new_account_joins": count,
                }),
                None,
            )
            .await;

            let _: () = state
                .redis
                .set(
                    &dedup_key,
                    "1",
                    Some(fred::prelude::Expiration::EX(300)),
                    None,
                    false,
                )
                .await
                .unwrap_or(());
        }
    }
}

async fn log_auto_action(
    state: &AppState,
    user_id: UserId,
    action_type: &str,
    signal: &mercury_core::models::AbuseSignal,
) {
    // Use a nil server_id since auto-actions are global
    // We need a server context for audit log — use nil UUID as sentinel
    let system_server = mercury_core::ids::ServerId(uuid::Uuid::nil());
    let system_mod = UserId(SYSTEM_MODERATOR_ID);

    let _ = mercury_moderation::audit::log_action(
        &state.db,
        system_server,
        system_mod,
        &format!("auto_action:{action_type}"),
        user_id,
        None,
        None,
        Some(serde_json::json!({
            "signal_id": signal.id,
            "signal_type": signal.signal_type,
            "auto_action": signal.auto_action,
        })),
    )
    .await;
}

async fn send_abuse_signal_event(
    state: &AppState,
    signal: &mercury_core::models::AbuseSignal,
) {
    let event = ServerMessage {
        t: ServerEvent::ABUSE_SIGNAL,
        d: serde_json::json!({
            "id": signal.id,
            "user_id": signal.user_id.to_string(),
            "signal_type": signal.signal_type,
            "severity": signal.severity,
            "auto_action": signal.auto_action,
            "created_at": signal.created_at.map(|t| t.to_rfc3339()),
        }),
        seq: None,
    };

    // Only send to connected users who are moderators/owners of at least one server.
    let connected = state.ws_manager.connected_user_ids();
    let mut moderators = Vec::new();
    for uid in &connected {
        if mercury_moderation::audit::is_any_server_mod_or_owner(&state.db, *uid)
            .await
            .unwrap_or(false)
        {
            moderators.push(*uid);
        }
    }
    if !moderators.is_empty() {
        state.ws_manager.send_to_users(&moderators, &event);
    }
}
