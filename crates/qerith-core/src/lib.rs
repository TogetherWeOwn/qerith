//! Qerith core: the product side of the shared velmora Usenet engine.
//!
//! The engine lives in `TogetherWeOwn/velmora`, pinned by immutable git
//! `rev` in this crate's `Cargo.toml`. No engine code is copied here.
//!
//! Only the non-crypto engine surface is re-exported: the NNTP client and
//! its transports, yEnc and the NZB parser. Media decryption is deliberately
//! not re-exported. The default-off archive-provider consumer bridge uses an
//! experimental immutable engine checkpoint; it grants neither provider
//! activation nor cryptographic or durability qualification.

pub mod catalogue;
pub mod composition;
pub mod native;
pub mod operations;
pub mod s3;
pub mod service;

pub use velmora::{nntp, nzb, segment_identity, transport, transports, yenc};
pub use velmora::{Error, Result};
