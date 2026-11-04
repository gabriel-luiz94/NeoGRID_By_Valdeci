//! neogrid-build como biblioteca (o binário `neogrid-build` é só o CLI fino).

pub mod build;
pub mod decode;
pub mod detect;
pub mod geom;
pub mod layers;
pub mod phase_a;
pub mod rows;
pub mod ruas;
pub mod schema_json;
pub mod stats;

pub use build::{build_database, BuildError, BuildResult, Options, ProgressCallback, ProgressEvent};
