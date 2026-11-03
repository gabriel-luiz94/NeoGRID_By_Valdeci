//! Esquemas JSON: `meta.schema` (neogrid-sqlite v2) e manifesto
//! (neogrid-build-manifest v1). Nomes de campo identicos aos do JS para o
//! leitor Electron continuar funcionando sem mudanca.

use serde::Serialize;
use std::collections::HashMap;
#[derive(Serialize)]
pub struct SchemaIndexes {
    pub id: isize,
    pub lon: isize,
    pub lat: isize,
    pub wkt: isize,
    pub angle: isize,
    #[serde(rename = "startPole")]
    pub start_pole: isize,
    #[serde(rename = "endPole")]
    pub end_pole: isize,
    pub pole: isize,
    pub length: isize,
}

#[derive(Serialize)]
pub struct Hotspot {
    pub cx: i64,
    pub cy: i64,
    pub count: u64,
}

#[derive(Serialize)]
pub struct LayerMeta {
    #[serde(rename = "type")]
    pub layer_type: String,
    pub name: String,
    pub headers: Vec<String>,
    pub count: u64,
    pub located: u64,
    pub missing: u64,
    pub duplicates: u64,
    #[serde(rename = "idPresent")]
    pub id_present: u64,
    #[serde(rename = "lengthMeters")]
    pub length_meters: f64,
    pub material: Vec<(String, u64)>,
    #[serde(rename = "poleType")]
    pub pole_type: Vec<(String, u64)>,
    #[serde(rename = "installationType")]
    pub installation_type: Vec<(String, u64)>,
    pub conductor: Vec<(String, u64)>,
    pub dicts: indexmap::IndexMap<String, Vec<String>>,
    pub bounds: Option<Bounds>,
    pub hotspots: Vec<Hotspot>,
    pub indexes: SchemaIndexes,
}

#[derive(Serialize)]
pub struct Bounds {
    pub west: f64,
    pub south: f64,
    pub east: f64,
    pub north: f64,
}

#[derive(Serialize)]
pub struct LinkCounts {
    pub inst: u64,
    pub nets: u64,
}

#[derive(Serialize)]
pub struct Schema {
    pub format: String,
    pub version: u32,
    #[serde(rename = "builtAt")]
    pub built_at: u64,
    pub source: String,
    pub rows: u64,
    pub located: u64,
    #[serde(rename = "totalLength")]
    pub total_length: f64,
    pub layers: Vec<LayerMeta>,
    pub links: LinkCounts,
    pub rejects: u64,
    pub imports: Vec<ManifestFile>,
}

// ---- manifesto ----

#[derive(Serialize, Clone)]
pub struct ManifestFile {
    pub file: String,
    pub layer: String,
    pub bytes: u64,
    pub rows: u64,
    pub rejects: u64,
    pub encoding: String,
    pub delimiter: String,
    #[serde(rename = "headerColumns")]
    pub header_columns: usize,
    pub conflict: bool,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub headers: Vec<String>,
}

#[derive(Serialize)]
pub struct ManifestLayer {
    pub rows: u64,
    pub located: u64,
    pub missing: u64,
    pub duplicates: u64,
    pub rejects: u64,
    pub headers: usize,
    #[serde(rename = "dictColumns")]
    pub dict_columns: usize,
    pub files: Vec<String>,
}

#[derive(Serialize)]
pub struct RejectSample {
    pub layer: String,
    pub file: String,
    pub line: u64,
    pub reason: String,
}

#[derive(Serialize)]
pub struct ColumnDiff {
    pub added: Vec<String>,
    pub removed: Vec<String>,
}

#[derive(Serialize)]
pub struct Manifest {
    pub format: String,
    pub version: u32,
    #[serde(rename = "builtAt")]
    pub built_at: u64,
    pub source: String,
    pub output: String,
    #[serde(rename = "rejectLimit")]
    pub reject_limit: f64,
    pub layers: HashMap<String, ManifestLayer>,
    pub files: Vec<ManifestFile>,
    #[serde(rename = "rejectsTotal")]
    pub rejects_total: u64,
    #[serde(rename = "rejectsSample")]
    pub rejects_sample: Vec<RejectSample>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub rows: Option<u64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub located: Option<u64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[serde(rename = "totalLength")]
    pub total_length: Option<f64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub links: Option<LinkCounts>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[serde(rename = "outputBytes")]
    pub output_bytes: Option<u64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub previous: Option<serde_json::Value>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[serde(rename = "newColumns")]
    pub new_columns: Option<HashMap<String, ColumnDiff>>,
}
