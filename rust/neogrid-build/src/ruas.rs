//! Pacote de ruas offline: lê um extrato `.osm.pbf` e grava as vias de Pernambuco
//! em ladrilhos de 0,02° (~2 km), no mesmo formato do cache baixado do Overpass.
//!
//! O resultado é um único arquivo SQLite, fácil de copiar para outra máquina.

use osmpbf::{Element, ElementReader};
use rusqlite::Connection;
use std::collections::BTreeMap;
use std::io::Write;
use std::path::Path;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;

pub const TILE_DEG: f64 = 0.02;
pub const FORMATO: &str = "neogrid-ruas";

/// Cobertura: Pernambuco com ~13 km de folga, em faixas de latitude de 0,1°, mais
/// Fernando de Noronha. Vem do contorno do IBGE. Formato: [sul, norte, oeste, leste].
pub const COBERTURA: &[[f64; 4]] = &[
    [-9.6, -9.5, -40.87, -36.79],
    [-9.5, -9.4, -40.87, -36.38],
    [-9.4, -9.3, -40.87, -36.14],
    [-9.3, -9.2, -40.94, -36.08],
    [-9.2, -9.1, -40.97, -35.98],
    [-9.1, -9.0, -41.02, -35.01],
    [-9.0, -8.9, -41.25, -34.97],
    [-8.9, -8.8, -41.46, -34.95],
    [-8.8, -8.7, -41.46, -34.89],
    [-8.7, -8.6, -41.46, -34.88],
    [-8.6, -8.5, -41.46, -34.84],
    [-8.5, -8.4, -41.33, -34.81],
    [-8.4, -8.3, -41.25, -34.79],
    [-8.3, -8.2, -41.16, -34.74],
    [-8.2, -8.1, -40.94, -34.71],
    [-8.1, -8.0, -40.83, -34.7],
    [-8.0, -7.9, -40.79, -34.7],
    [-7.9, -7.8, -40.79, -34.69],
    [-7.8, -7.7, -40.8, -34.69],
    [-7.7, -7.6, -40.84, -34.69],
    [-7.6, -7.5, -40.84, -34.69],
    [-7.5, -7.4, -40.84, -34.69],
    [-7.4, -7.3, -40.84, -34.84],
    [-7.3, -7.2, -40.82, -34.87],
    [-7.2, -7.1, -40.47, -37.02],
    [-3.95, -3.75, -32.6, -32.3],
];

pub fn dentro_da_cobertura(lat: f64, lon: f64) -> bool {
    COBERTURA.iter().any(|f| lat >= f[0] && lat <= f[1] && lon >= f[2] && lon <= f[3])
}

/// Mesmas etiquetas guardadas pelo cache do Overpass.
const MANTER: [&str; 8] = ["highway", "name", "width", "est_width", "lanes", "oneway", "tunnel", "bridge"];
/// Vias que não existem no terreno ou objetos que o OSM também etiqueta como `highway`.
const IGNORAR: [&str; 11] = ["proposed", "abandoned", "bus_stop", "platform", "elevator", "rest_area", "services", "dummy", "raceway", "traffic_island", "U"];

pub enum PackEvent {
    /// Fase, 0..=1 quando conhecido.
    Etapa(&'static str, Option<f64>),
    Log(String),
}

pub type PackCallback = Arc<dyn Fn(PackEvent) + Send + Sync>;

pub struct PackInfo {
    pub vias: u64,
    pub ladrilhos: u64,
    pub bytes: u64,
    pub por_tipo: BTreeMap<String, u64>,
}

fn json_str(out: &mut String, text: &str) {
    out.push('"');
    for c in text.chars() {
        match c {
            '"' => out.push_str("\\\""),
            '\\' => out.push_str("\\\\"),
            c if (c as u32) < 0x20 => out.push_str(&format!("\\u{:04x}", c as u32)),
            c => out.push(c),
        }
    }
    out.push('"');
}

/// Grava em temporário e renomeia: uma falha não destrói o pacote anterior.
pub fn build_pack(
    pbf: &Path,
    output: &Path,
    origem: &str,
    data: &str,
    cancel: Option<Arc<AtomicBool>>,
    on_event: Option<PackCallback>,
) -> Result<PackInfo, String> {
    let emit = |e: PackEvent| {
        if let Some(cb) = &on_event {
            cb(e);
        }
    };
    let cancelado = || cancel.as_ref().map(|c| c.load(Ordering::Relaxed)).unwrap_or(false);
    let total = std::fs::metadata(pbf).map_err(|e| format!("ler {}: {e}", pbf.display()))?.len().max(1);
    emit(PackEvent::Etapa("Lendo o extrato do OpenStreetMap", None));

    // O .osm.pbf traz os nós ordenados por id e antes das vias: uma passada só basta.
    // Guarda só o que cai na cobertura, para caber em memória.
    let mut nos: Vec<(i64, i32, i32)> = Vec::new();
    let mut vias: Vec<String> = Vec::new();
    let mut tiles: BTreeMap<(i32, i32), Vec<u32>> = BTreeMap::new();
    let mut por_tipo: BTreeMap<String, u64> = BTreeMap::new();
    let mut lidos: u64 = 0;
    let reader = ElementReader::from_path(pbf).map_err(|e| format!("abrir PBF: {e}"))?;
    let mut parou = false;
    reader
        .for_each(|element| {
            lidos += 1;
            if lidos % 2_000_000 == 0 {
                if cancelado() {
                    parou = true;
                }
                emit(PackEvent::Log(format!("{} elementos lidos, {} vias", lidos, vias.len())));
            }
            if parou {
                return;
            }
            match element {
                Element::DenseNode(n) => {
                    guardar_no(&mut nos, n.id(), n.lat(), n.lon());
                }
                Element::Node(n) => {
                    guardar_no(&mut nos, n.id(), n.lat(), n.lon());
                }
                Element::Way(way) => {
                    let mut highway = None;
                    let mut tags: Vec<(&str, &str)> = Vec::new();
                    for (k, v) in way.tags() {
                        if k == "highway" {
                            highway = Some(v);
                        }
                        if MANTER.contains(&k) {
                            tags.push((k, v));
                        }
                    }
                    let Some(tipo) = highway else { return };
                    if IGNORAR.contains(&tipo) {
                        return;
                    }
                    let mut pontos: Vec<(f64, f64)> = Vec::new();
                    for id in way.refs() {
                        if let Ok(pos) = nos.binary_search_by_key(&id, |n| n.0) {
                            pontos.push((nos[pos].1 as f64 / 1e6, nos[pos].2 as f64 / 1e6));
                        }
                    }
                    if pontos.len() < 2 {
                        return;
                    }
                    // Coordenadas em milionésimos de grau, cada uma como diferença da anterior:
                    // comprime bem melhor que texto absoluto.
                    let mut js = String::with_capacity(pontos.len() * 12 + 60);
                    js.push_str(&format!("{{\"i\":{},\"d\":[", way.id()));
                    let (mut la0, mut lo0) = (0i64, 0i64);
                    for (i, (lat, lon)) in pontos.iter().enumerate() {
                        let (la, lo) = ((lat * 1e6).round() as i64, (lon * 1e6).round() as i64);
                        if i > 0 {
                            js.push(',');
                        }
                        js.push_str(&format!("{},{}", la - la0, lo - lo0));
                        la0 = la;
                        lo0 = lo;
                    }
                    js.push_str("],\"t\":{");
                    for (i, (k, v)) in tags.iter().enumerate() {
                        if i > 0 {
                            js.push(',');
                        }
                        json_str(&mut js, k);
                        js.push(':');
                        json_str(&mut js, v);
                    }
                    js.push_str("}}");
                    let indice = vias.len() as u32;
                    vias.push(js);
                    *por_tipo.entry(tipo.to_string()).or_insert(0) += 1;
                    // Só os ladrilhos por onde a via passa: rodovias longas não entram em toda a sua caixa.
                    let mut passou: Vec<(i32, i32)> = Vec::new();
                    let mut marcar = |lat: f64, lon: f64| {
                        let t = ((lon / TILE_DEG).floor() as i32, (lat / TILE_DEG).floor() as i32);
                        if passou.last() != Some(&t) && !passou.contains(&t) {
                            passou.push(t);
                        }
                    };
                    for par in pontos.windows(2) {
                        let (la0, lo0) = par[0];
                        let (la1, lo1) = par[1];
                        let passos = (((la1 - la0).abs().max((lo1 - lo0).abs()) / (TILE_DEG / 2.0)).ceil() as usize).max(1);
                        for k in 0..=passos {
                            let f = k as f64 / passos as f64;
                            marcar(la0 + (la1 - la0) * f, lo0 + (lo1 - lo0) * f);
                        }
                    }
                    for t in passou {
                        tiles.entry(t).or_default().push(indice);
                    }
                }
                Element::Relation(_) => {}
            }
        })
        .map_err(|e| format!("ler PBF: {e}"))?;
    if parou {
        return Err("Geração do pacote cancelada.".to_string());
    }
    drop(nos);
    emit(PackEvent::Log(format!("{} MB lidos: {} vias em {} ladrilhos", total / 1_048_576, vias.len(), tiles.len())));
    if vias.is_empty() {
        return Err("O extrato não tem vias de Pernambuco.".to_string());
    }

    emit(PackEvent::Etapa("Gravando o pacote de ruas", Some(0.0)));
    let temp = output.with_extension("tmp");
    let _ = std::fs::remove_file(&temp);
    if let Some(parent) = output.parent() {
        if !parent.as_os_str().is_empty() {
            std::fs::create_dir_all(parent).map_err(|e| format!("criar pasta: {e}"))?;
        }
    }
    let gravar = || -> Result<(), String> {
        let mut db = Connection::open(&temp).map_err(|e| format!("criar pacote: {e}"))?;
        db.execute_batch(
            "PRAGMA journal_mode = OFF; PRAGMA synchronous = OFF; PRAGMA page_size = 4096;
             CREATE TABLE meta (k TEXT PRIMARY KEY, v TEXT NOT NULL);
             CREATE TABLE tiles (k TEXT PRIMARY KEY, z BLOB NOT NULL) WITHOUT ROWID;",
        )
        .map_err(|e| e.to_string())?;
        let tx = db.transaction().map_err(|e| e.to_string())?;
        {
            let mut ins = tx.prepare("INSERT INTO tiles (k, z) VALUES (?, ?)").map_err(|e| e.to_string())?;
            let n = tiles.len().max(1);
            for (feitos, ((ix, iy), lista)) in tiles.iter().enumerate() {
                if feitos % 500 == 0 {
                    if cancelado() {
                        return Err("Geração do pacote cancelada.".to_string());
                    }
                    emit(PackEvent::Etapa("Gravando o pacote de ruas", Some(feitos as f64 / n as f64)));
                }
                let mut enc = flate2::write::ZlibEncoder::new(Vec::new(), flate2::Compression::best());
                enc.write_all(format!("{{\"v\":2,\"data\":\"{data}\",\"ways\":[").as_bytes()).map_err(|e| e.to_string())?;
                for (i, v) in lista.iter().enumerate() {
                    if i > 0 {
                        enc.write_all(b",").map_err(|e| e.to_string())?;
                    }
                    enc.write_all(vias[*v as usize].as_bytes()).map_err(|e| e.to_string())?;
                }
                enc.write_all(b"]}").map_err(|e| e.to_string())?;
                let z = enc.finish().map_err(|e| e.to_string())?;
                ins.execute(rusqlite::params![format!("{ix}:{iy}"), z]).map_err(|e| e.to_string())?;
            }
        }
        tx.commit().map_err(|e| e.to_string())?;
        let info = serde_json::json!({
            "formato": FORMATO,
            "origem": origem,
            "data": data,
            "vias": vias.len(),
            "ladrilhos": tiles.len(),
            "porTipo": por_tipo,
            "cobertura": COBERTURA,
            "atribuicao": "© colaboradores do OpenStreetMap (ODbL)",
        });
        db.execute("INSERT INTO meta (k, v) VALUES ('info', ?)", [info.to_string()]).map_err(|e| e.to_string())?;
        db.execute_batch("VACUUM;").map_err(|e| e.to_string())?;
        Ok(())
    };
    if let Err(error) = gravar() {
        let _ = std::fs::remove_file(&temp);
        return Err(error);
    }
    std::fs::rename(&temp, output).map_err(|e| {
        let _ = std::fs::remove_file(&temp);
        format!("finalizar pacote: {e}")
    })?;
    let bytes = std::fs::metadata(output).map(|m| m.len()).unwrap_or(0);
    Ok(PackInfo { vias: vias.len() as u64, ladrilhos: tiles.len() as u64, bytes, por_tipo })
}

fn guardar_no(nos: &mut Vec<(i64, i32, i32)>, id: i64, lat: f64, lon: f64) {
    if dentro_da_cobertura(lat, lon) {
        nos.push((id, (lat * 1e6).round() as i32, (lon * 1e6).round() as i32));
    }
}

/// Valida um arquivo de pacote e devolve os metadados.
pub fn read_info(conn: &Connection) -> Result<serde_json::Value, String> {
    let text: String = conn
        .query_row("SELECT v FROM meta WHERE k = 'info'", [], |r| r.get(0))
        .map_err(|_| "Este arquivo não é um pacote de ruas do NeoGrid.".to_string())?;
    let info: serde_json::Value = serde_json::from_str(&text).map_err(|e| e.to_string())?;
    if info.get("formato").and_then(|v| v.as_str()) != Some(FORMATO) {
        return Err("Este arquivo não é um pacote de ruas do NeoGrid.".to_string());
    }
    Ok(info)
}

/// JSON de um ladrilho, ou `None` se o pacote não tem vias nele.
pub fn read_tile(conn: &Connection, key: &str) -> Result<Option<String>, String> {
    use rusqlite::OptionalExtension as _;
    use std::io::Read as _;
    let blob: Option<Vec<u8>> = conn
        .query_row("SELECT z FROM tiles WHERE k = ?", [key], |r| r.get(0))
        .optional()
        .map_err(|e| e.to_string())?;
    let Some(blob) = blob else { return Ok(None) };
    let mut text = String::new();
    flate2::read::ZlibDecoder::new(&blob[..]).read_to_string(&mut text).map_err(|e| e.to_string())?;
    Ok(Some(text))
}
