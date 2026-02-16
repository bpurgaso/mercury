use serde::{Deserialize, Serialize};
use uuid::Uuid;

macro_rules! typed_id {
    ($name:ident) => {
        #[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize, sqlx::Type)]
        #[sqlx(transparent)]
        pub struct $name(pub Uuid);

        impl $name {
            pub fn new() -> Self {
                Self(Uuid::now_v7())
            }
        }

        impl std::fmt::Display for $name {
            fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
                self.0.fmt(f)
            }
        }
    };
}

typed_id!(UserId);
typed_id!(ServerId);
typed_id!(ChannelId);
typed_id!(MessageId);
typed_id!(DmChannelId);
typed_id!(DeviceId);
typed_id!(ReportId);

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn uuid_v7_is_time_sorted() {
        let mut ids: Vec<UserId> = Vec::new();
        for _ in 0..100 {
            ids.push(UserId::new());
        }

        // Each subsequent UUIDv7 should be >= the previous one
        // because UUIDv7 embeds a millisecond timestamp in the high bits
        for window in ids.windows(2) {
            assert!(
                window[1].0 >= window[0].0,
                "UUIDv7 should be time-sorted: {:?} should be >= {:?}",
                window[1].0,
                window[0].0
            );
        }
    }

    #[test]
    fn uuid_v7_are_unique() {
        let ids: Vec<UserId> = (0..1000).map(|_| UserId::new()).collect();
        let unique: std::collections::HashSet<_> = ids.iter().collect();
        assert_eq!(ids.len(), unique.len(), "All UUIDv7 values should be unique");
    }

    #[test]
    fn typed_ids_are_distinct_types() {
        // This test verifies at compile time that typed IDs are distinct types.
        // A UserId cannot be accidentally passed where a ServerId is expected.
        let user_id = UserId::new();
        let server_id = ServerId::new();
        assert_ne!(
            std::any::TypeId::of::<UserId>(),
            std::any::TypeId::of::<ServerId>()
        );
        // But both wrap UUIDs
        let _: Uuid = user_id.0;
        let _: Uuid = server_id.0;
    }

    #[test]
    fn typed_id_display() {
        let id = UserId::new();
        let displayed = format!("{}", id);
        // UUIDv7 display should be a valid UUID string
        assert!(Uuid::parse_str(&displayed).is_ok());
    }

    #[test]
    fn typed_id_serde_roundtrip() {
        let id = UserId::new();
        let json = serde_json::to_string(&id).unwrap();
        let deserialized: UserId = serde_json::from_str(&json).unwrap();
        assert_eq!(id, deserialized);
    }
}
