//! Nucleo Rust do NeoGrid — PoC com paridade ao JS.
//!
//! Cada funcao espelha um trecho do JS citado no docstring.
//! Sem dependencias externas: so std, para compilar offline.

pub mod classify;
pub mod delimiter;
pub mod encoding;
pub mod header;
pub mod number;
pub mod utm;
pub mod wkt;

pub use classify::Layer;
