//! Geometria: `encodeGeometry` (espelha `db-build.js`).
//! Vazio -> NULL; >200 caracteres -> zlib deflate (BLOB); senao TEXT.

use flate2::{write::ZlibEncoder, Compression};
use std::io::Write;

use crate::layers::WKT_DEFLATE_OVER;

pub enum GeomValue {
    Null,
    Short,
    Blob(Vec<u8>),
}

pub fn encode_geometry(raw: &str) -> GeomValue {
    if raw.is_empty() {
        return GeomValue::Null;
    }
    if raw.len() > WKT_DEFLATE_OVER {
        let mut enc = ZlibEncoder::new(Vec::new(), Compression::new(6));
        enc.write_all(raw.as_bytes())
            .expect("zlib encode");
        GeomValue::Blob(enc.finish().expect("zlib finish"))
    } else {
        GeomValue::Short
    }
}
