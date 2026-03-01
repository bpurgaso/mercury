pub mod abuse;
pub mod audit;
pub mod bans;
pub mod blocks;
pub mod mutes;
pub mod reports;

use uuid::Uuid;

/// System sentinel UUID used as moderator_id for automated actions.
pub const SYSTEM_MODERATOR_ID: Uuid = Uuid::nil();
