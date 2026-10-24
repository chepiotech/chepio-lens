/// The current time as the caller sees it.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Now {
    /// Monotonic milliseconds, for windows and rate buckets.
    pub mono_ms: u64,
    /// Wall time in nanoseconds since the Unix epoch, for timestamps shown to people.
    pub unix_ns: u64,
}
