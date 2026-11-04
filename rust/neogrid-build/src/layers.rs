//! Constantes de camada (espelham `db-build.js: LAYER_ORDER/TITLES/ID_HEADERS/...`).

use neogrid_core::classify::Layer;
use std::collections::HashMap;

pub const LAYER_ORDER: [Layer; 4] = [Layer::Poste, Layer::Bt, Layer::Mt, Layer::Inst];

pub fn layer_title(l: Layer) -> &'static str {
    match l {
        Layer::Poste => "Postes",
        Layer::Bt => "Rede BT",
        Layer::Mt => "Rede MT",
        Layer::Inst => "Instalações",
    }
}

pub fn id_headers(l: Layer) -> &'static [&'static str] {
    match l {
        Layer::Poste => &["NU_PG_ID"],
        Layer::Inst => &["NU_INSTALACAO_MT_ID", "NU_INSTALA"],
        Layer::Bt => &["NU_TRECHO_BT_ID", "NU_TRECHO"],
        Layer::Mt => &["NU_TRECHO_MT_ID", "NU_TRECHO"],
    }
}

pub const LON_HEADERS: &[&str] = &["NU_LONGITUDE", "GEO_X", "LONGITUDE", "LON"];
pub const LAT_HEADERS: &[&str] = &["NU_LATITUDE", "GEO_Y", "LATITUDE", "LAT"];
pub const WKT_HEADERS: &[&str] = &["GEOMETRIA_WKT"];
pub const LENGTH_HEADERS: &[&str] = &["NU_COMPRIMENTO_REAL", "SHP_LENGTH"];

/// Coluna derivada da pasta de origem de cada arquivo.
pub const REGIONAL_HEADER: &str = "REGIONAL";

pub const DICT_MAX_DISTINCT: usize = 2000;
pub const DICT_TRACK_CAP: usize = 5000;
/// `WKT_DEFLATE_OVER` — JS compara `text.length` (unidades UTF-16);
/// WKT e ASCII, entao bytes == unidades.
pub const WKT_DEFLATE_OVER: usize = 200;

fn find_first(headers: &[String], names: &[&str]) -> isize {
    for name in names {
        if let Some(i) = headers.iter().position(|h| h == name) {
            return i as isize;
        }
    }
    -1
}

/// Indices resolvidos sobre a uniao de headers (espelha a Fase B do JS).
pub struct LayerIndexes {
    pub id: isize,
    pub lon: isize,
    pub lat: isize,
    pub wkt: isize,
    pub length: isize,
    pub angle: isize,
    pub start_pole: isize,
    pub end_pole: isize,
    pub pole: isize,
}

pub fn resolve_indexes(layer: Layer, headers: &[String]) -> LayerIndexes {
    let find = |name: &str| {
        headers
            .iter()
            .position(|h| h == name)
            .map(|i| i as isize)
            .unwrap_or(-1)
    };
    LayerIndexes {
        id: find_first(headers, id_headers(layer)),
        lon: find_first(headers, LON_HEADERS),
        lat: find_first(headers, LAT_HEADERS),
        wkt: find_first(headers, WKT_HEADERS),
        length: find_first(headers, LENGTH_HEADERS),
        angle: find("NU_ANGULO"),
        start_pole: headers
            .iter()
            .position(|h| h.starts_with("NU_PG_INI"))
            .map(|i| i as isize)
            .unwrap_or(-1),
        end_pole: headers
            .iter()
            .position(|h| h.starts_with("NU_PG_FIN"))
            .map(|i| i as isize)
            .unwrap_or(-1),
        pole: find("NU_PG_ID"),
    }
}

/// Uniao de headers na ordem de primeira aparicao (espelha o JS).
pub fn union_headers(files: &[usize], infos: &[crate::detect::FileInfo]) -> Vec<String> {
    let mut out = Vec::new();
    let mut seen = std::collections::HashSet::new();
    for &fi in files {
        for h in &infos[fi].headers {
            if seen.insert(h.clone()) {
                out.push(h.clone());
            }
        }
    }
    if files.iter().any(|&fi| infos[fi].regional.is_some()) && seen.insert(REGIONAL_HEADER.to_string()) {
        out.push(REGIONAL_HEADER.to_string());
    }
    out
}

pub fn header_index_map(headers: &[String]) -> HashMap<&str, usize> {
    headers
        .iter()
        .enumerate()
        .map(|(i, h)| (h.as_str(), i))
        .collect()
}
