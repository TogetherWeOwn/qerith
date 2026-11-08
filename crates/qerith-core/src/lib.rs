//! Qerith core: the product side of the shared velmora Usenet engine.
//!
//! The engine lives in `TogetherWeOwn/velmora`, pinned by immutable git
//! `rev` in this crate's `Cargo.toml`. No engine code is copied here.
//!
//! Only the non-crypto engine surface is re-exported: the NNTP client and
//! its transports, yEnc and the NZB parser. `velmora::decrypt`
//! (rclone-crypt) is deliberately not part of this crate's surface; its
//! replacement STREAM format lands in velmora first and Qerith moves to
//! that pin once it merges.

pub mod operations;
pub mod s3;

pub use velmora::{nntp, nzb, segment_identity, transport, transports, yenc};
pub use velmora::{Error, Result};
