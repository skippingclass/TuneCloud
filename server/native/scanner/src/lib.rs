pub mod fingerprints;
pub mod listing;
pub mod protocol;

/// Integers beyond this limit cannot be represented exactly by the Node bridge.
pub const MAX_SAFE_INTEGER: u64 = 9_007_199_254_740_991;
