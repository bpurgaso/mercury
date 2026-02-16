use std::sync::atomic::{AtomicU64, Ordering};
use std::time::{SystemTime, UNIX_EPOCH};

/// Global rate limiter for WebSocket upgrade requests.
///
/// Limits the number of WebSocket upgrades per second across the entire server
/// to protect against thundering herd reconnection storms. This is separate
/// from the per-IP auth rate limiter — it protects the upgrade path itself.
pub struct GlobalWsRateLimiter {
    /// Number of upgrades in the current time window.
    count: AtomicU64,
    /// The epoch second of the current window.
    window_epoch_secs: AtomicU64,
    /// Maximum upgrades allowed per second.
    max_per_second: u64,
}

impl GlobalWsRateLimiter {
    pub fn new(max_per_second: u64) -> Self {
        Self {
            count: AtomicU64::new(0),
            window_epoch_secs: AtomicU64::new(0),
            max_per_second,
        }
    }

    /// Try to acquire a permit for one WebSocket upgrade.
    /// Returns `true` if allowed, `false` if rate limited.
    pub fn try_acquire(&self) -> bool {
        let now_secs = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .expect("system clock before UNIX epoch")
            .as_secs();

        let stored_secs = self.window_epoch_secs.load(Ordering::Relaxed);

        if now_secs != stored_secs {
            // New second window — try to claim the reset
            if self
                .window_epoch_secs
                .compare_exchange(stored_secs, now_secs, Ordering::Relaxed, Ordering::Relaxed)
                .is_ok()
            {
                self.count.store(1, Ordering::Relaxed);
                return true;
            }
            // Another thread already reset — fall through to normal increment
        }

        let prev = self.count.fetch_add(1, Ordering::Relaxed);
        if prev >= self.max_per_second {
            self.count.fetch_sub(1, Ordering::Relaxed);
            return false;
        }
        true
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn rate_limiter_allows_under_limit() {
        let limiter = GlobalWsRateLimiter::new(5);
        for _ in 0..5 {
            assert!(limiter.try_acquire());
        }
    }

    #[test]
    fn rate_limiter_blocks_over_limit() {
        let limiter = GlobalWsRateLimiter::new(3);
        assert!(limiter.try_acquire());
        assert!(limiter.try_acquire());
        assert!(limiter.try_acquire());
        assert!(!limiter.try_acquire());
        assert!(!limiter.try_acquire());
    }

    #[test]
    fn rate_limiter_resets_on_new_second() {
        let limiter = GlobalWsRateLimiter::new(2);
        assert!(limiter.try_acquire());
        assert!(limiter.try_acquire());
        assert!(!limiter.try_acquire());

        // Simulate time advancing by directly resetting the window
        limiter.window_epoch_secs.store(0, Ordering::Relaxed);
        assert!(limiter.try_acquire());
    }
}
