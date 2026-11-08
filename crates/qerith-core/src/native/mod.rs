//! Versioned native-client contracts, independent of transport and catalogue storage.
//!
//! Validation establishes protocol consistency, not correct encryption, possession
//! of a key, persistence, or authorization by itself. See `docs/native-protocol.md`.

mod validate;
mod wire;

pub use validate::*;
pub use wire::*;
