// Core
use std::time::{Instant, SystemTime, UNIX_EPOCH};

// Domain
use crate::domain::time::Now;

/// Reads the monotonic and the wall clock; services take `Now` as a parameter so tests can control time.
#[derive(Debug, Clone, Copy)]
pub struct Clock {
    start: Instant,
}

impl Default for Clock {
    fn default() -> Self {
        Self {
            start: Instant::now(),
        }
    }
}

impl Clock {
    pub fn now(&self) -> Now {
        let unix_ns = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .map_or(0, |since| {
                u64::try_from(since.as_nanos()).unwrap_or(u64::MAX)
            });
        Now {
            mono_ms: u64::try_from(self.start.elapsed().as_millis()).unwrap_or(u64::MAX),
            unix_ns,
        }
    }
}
