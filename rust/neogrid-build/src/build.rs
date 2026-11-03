//! Orquestrador CSV -> SQLite. Espelha `electron/db-build.js: buildDatabase`
//! (fases 0/A/B, vinculos, indices, schema, manifesto, validacao).
//!
//! Desvios documentados (comportamento identico nas bases reais; correto nas
//! bases minusculas onde o JS tem bugs latentes):
//! - `_id` e colunas de vinculo usam o texto DECODIFICADO (o JS usa o codigo
//!   do dicionario quando a coluna e elegivel, o que so ocorre com <2000 ids).

use rusqlite::{params_from_iter, types::Value, Connection};
use std::collections::{HashMap, HashSet};
use std::path::{Path, PathBuf};
use std::sync::{
    atomic::{AtomicBool, Ordering},
    Arc,
};
use std::time::{SystemTime, UNIX_EPOCH};

use neogrid_core::classify::Layer;
use neogrid_core::wkt;

use crate::decode;
use crate::detect::FileInfo;
use crate::geom;
use crate::layers;
use crate::phase_a;
use crate::rows;
use crate::schema_json as sj;
use crate::{detect, layers::LayerIndexes};

/// Eventos de progresso (espelham o `onProgress` do JS: `log`, `phase`,
/// `scan-progress`/`load-progress`, `done`/`cancelled`/`error` sao do shell).
#[derive(Clone, Debug)]
pub enum ProgressEvent {
    Log(String),
    Phase {
        phase: &'static str,
        layer: String,
        file: String,
        file_number: usize,
        file_count: usize,
    },
    /// `scan == true` → fase A; senão fase B. Bytes sobre o texto decodificado.
    Progress {
        scan: bool,
        layer: String,
        file: String,
        bytes: u64,
        total_bytes: u64,
    },
}

pub type ProgressCallback = Arc<dyn Fn(ProgressEvent) + Send + Sync>;

pub struct Options {
    pub source: PathBuf,
    pub output: PathBuf,
    pub manifesto_base: Option<PathBuf>,
    pub manifesto_out: Option<PathBuf>,
    pub reject_limit: f64,
    /// Cancelamento cooperativo (verificado entre arquivos e a cada 2048 linhas).
    pub cancel: Option<Arc<AtomicBool>>,
    pub on_progress: Option<ProgressCallback>,
}

#[derive(Debug)]
pub enum BuildError {    /// `code === 'BUILD_CANCELLED'` no JS.
    Cancelled,
    Failed(String),
}

impl std::fmt::Display for BuildError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            BuildError::Cancelled => write!(f, "BUILD_CANCELLED: Conversão cancelada."),
            BuildError::Failed(e) => write!(f, "{e}"),
        }
    }
}

impl From<String> for BuildError {
    fn from(e: String) -> Self {
        BuildError::Failed(e)
    }
}


#[derive(Debug)]
pub struct BuildResult {
    pub output: PathBuf,
    pub manifesto_out: PathBuf,
    pub rows: u64,
    /// Manifesto completo (para o evento `done` e o retorno do command).
    pub manifest: serde_json::Value,
}

fn now_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
    }

fn fmt_int(v: f64) -> String {
    let neg = v < 0.0;
    let mut s = format!("{}", v.abs().round() as u64);
    let mut out = String::new();
    while s.len() > 3 {
        let tail = s.split_off(s.len() - 3);
        out = format!(".{}{}", tail, out);
    }
    out = format!("{}{}", s, out);
    if neg {
        format!("-{}", out)
    } else {
        out
    }
}

fn quote_ident(name: &str) -> String {
    format!("\"{}\"", name.replace('"', "\"\""))
}

/// Relata progresso para o shell (CLI imprime; Tauri emite evento).
#[derive(Clone)]
pub struct Reporter {
    cb: Option<ProgressCallback>,
}

impl Reporter {
    pub fn new(cb: Option<ProgressCallback>) -> Self {
        Self { cb }
    }

    pub fn log(&self, msg: String) {
        if let Some(cb) = &self.cb {
            cb(ProgressEvent::Log(msg));
        }
    }

    pub fn phase(&self, phase: &'static str, layer: &str, file: &str, file_number: usize, file_count: usize) {
        if let Some(cb) = &self.cb {
            cb(ProgressEvent::Phase {
                phase,
                layer: layer.to_string(),
                file: file.to_string(),
                file_number,
                file_count,
            });
        }
    }

    pub fn progress(&self, scan: bool, layer: &str, file: &str, bytes: u64, total_bytes: u64) {
        if let Some(cb) = &self.cb {
            cb(ProgressEvent::Progress {
                scan,
                layer: layer.to_string(),
                file: file.to_string(),
                bytes,
                total_bytes,
            });
        }
    }
}

fn check_cancel(cancel: &Option<Arc<AtomicBool>>) -> Result<(), BuildError> {
    if cancel.as_ref().map(|c| c.load(Ordering::Relaxed)).unwrap_or(false) {
        return Err(BuildError::Cancelled);
    }
    Ok(())
}

fn rel(source: &Path, file: &Path) -> String {
    file.strip_prefix(source)
        .map(|p| p.to_string_lossy().replace('\\', "/"))
        .unwrap_or_else(|_| file.to_string_lossy().to_string())
}

fn read_decode(info: &FileInfo) -> Result<String, String> {
    let bytes = std::fs::read(&info.file).map_err(|e| format!("ler {}: {e}", info.file.display()))?;
    Ok(decode::decode_bytes(&bytes, info.encoding))
}

fn to_number_opt(s: &str) -> Option<f64> {
    neogrid_core::number::to_number(s)
}

pub fn build_database(opts: &Options) -> Result<BuildResult, BuildError> {
    let source = opts.source.clone();
    let output = opts.output.clone();
    let rep = Reporter::new(opts.on_progress.clone());
    if !source.exists() {
        return Err(BuildError::Failed(format!("Pasta não encontrada: {}", source.display())));
    }

    // ---- Fase 0 ----
    let infos = detect::scan_sources(&source)?;
    let mut by_layer: HashMap<&'static str, Vec<usize>> = HashMap::new();
    for key in ["poste", "bt", "mt", "inst"] {
        by_layer.insert(key, Vec::new());
    }
    for (i, info) in infos.iter().enumerate() {
        if let Some(layer) = info.layer {
            by_layer.get_mut(layer.as_str()).unwrap().push(i);
        } else {
            rep.log(format!(
                "AVISO: camada não identificada para {} — arquivo ignorado.",
                info.file.file_name().unwrap_or_default().to_string_lossy()
            ));
        }
        if info.conflict {
            let bn = info.by_name.map(|l| l.as_str()).unwrap_or("?");
            let bh = info.by_headers.map(|l| l.as_str()).unwrap_or("?");
            let ly = info.layer.map(|l| l.as_str()).unwrap_or("?");
            rep.log(format!(
                "AVISO: {} parece {} pelo nome, mas {} pelo cabeçalho — usando {}.",
                info.file.file_name().unwrap_or_default().to_string_lossy(),
                bn,
                bh,
                ly
            ));
        }
    }

    let order = layers::LAYER_ORDER;
    let mut headers_by_layer: HashMap<&'static str, Vec<String>> = HashMap::new();
    for &layer in &order {
        let files = &by_layer[layer.as_str()];
        let union = layers::union_headers(files, &infos);
        rep.log(format!(
            "{}: {} arquivo(s), {} coluna(s)",
            layer.as_str(),
            files.len(),
            union.len()
        ));
        headers_by_layer.insert(layer.as_str(), union);
    }

    if output.exists() {
        rep.log(format!("Removendo banco anterior: {}", output.display()));
        std::fs::remove_file(&output).map_err(|e| format!("remover banco: {e}"))?;
        let _ = std::fs::remove_file(format!("{}-wal", output.display()));
        let _ = std::fs::remove_file(format!("{}-shm", output.display()));
    }

    // Melhoria sobre o JS: cria o diretório de saída (o diálogo sempre
    // entrega diretório existente, mas o CLI/API agradecem).
    if let Some(parent) = output.parent() {
        if !parent.as_os_str().is_empty() {
            std::fs::create_dir_all(parent).map_err(|e| format!("mkdir saída: {e}"))?;
        }
    }

    let mut db = Connection::open(&output).map_err(|e| format!("abrir banco: {e}"))?;
    let result = build_into(&mut db, opts, &source, &infos, &by_layer, &headers_by_layer);
    drop(db);
    match result {
        Ok(r) => Ok(r),
        Err(e) => {
            // Falha sem gerar banco (espelha o descarte do JS).
            let _ = std::fs::remove_file(&output);
            Err(e)
        }
    }
}

#[allow(clippy::too_many_arguments)]
fn build_into(
    db: &mut Connection,
    opts: &Options,
    source: &Path,
    infos: &[FileInfo],
    by_layer: &HashMap<&'static str, Vec<usize>>,
    headers_by_layer: &HashMap<&'static str, Vec<String>>,
) -> Result<BuildResult, BuildError> {
    let rep = Reporter::new(opts.on_progress.clone());
    db.execute_batch(
        "PRAGMA journal_mode = OFF;
         PRAGMA synchronous = OFF;
         PRAGMA temp_store = MEMORY;
         PRAGMA cache_size = -131072;
         CREATE TABLE IF NOT EXISTS meta (\"key\" TEXT PRIMARY KEY, \"value\" TEXT);
         CREATE TABLE IF NOT EXISTS \"_rejects\" (
           \"layer\" TEXT, \"file\" TEXT, \"line\" INTEGER, \"reason\" TEXT, \"content\" TEXT
         );",
    )
    .map_err(|e| format!("pragmas: {e}"))?;

    let started = now_ms();
    let mut manifest_files: Vec<sj::ManifestFile> = Vec::new();
    let mut manifest_layers: HashMap<String, sj::ManifestLayer> = HashMap::new();
    let mut rejects_total: u64 = 0;
    let mut rejects_sample: Vec<sj::RejectSample> = Vec::new();
    let mut layers_meta: Vec<sj::LayerMeta> = Vec::new();
    let mut layer_rows: HashMap<&'static str, u64> = HashMap::new();
    let mut layer_located: HashMap<&'static str, u64> = HashMap::new();
    let mut layer_length: HashMap<&'static str, f64> = HashMap::new();

    let order = layers::LAYER_ORDER;

    for &layer in &order {
        let files = &by_layer[layer.as_str()];
        if files.is_empty() {
            continue;
        }
        let headers = &headers_by_layer[layer.as_str()];
        let ncols = headers.len();
        let union_index = layers::header_index_map(headers);
        let ix = layers::resolve_indexes(layer, headers);

        // ---- Fase A ----
        // Decodifica uma vez por arquivo e reutiliza na fase B (o JS le 2x).
        rep.log(format!("{}: fase A (cardinalidade)…", layer.as_str()));
        let mut ineligible: HashSet<usize> = HashSet::new();
        for idx in [ix.wkt, ix.lon, ix.lat] {
            if idx >= 0 {
                ineligible.insert(idx as usize);
            }
        }
        let mut texts: Vec<String> = Vec::with_capacity(files.len());
        let mut inverses: Vec<Vec<Option<usize>>> = Vec::with_capacity(files.len());
        for &fi in files {
            texts.push(read_decode(&infos[fi])?);
            inverses.push(phase_a::invert_targets(
                &phase_a::map_targets(&infos[fi].headers, &union_index),
                ncols,
            ));
        }
        let mut phase = phase_a::PhaseA::new(ncols, ineligible);
        for (k, &fi) in files.iter().enumerate() {
            check_cancel(&opts.cancel)?;
            let info = &infos[fi];
            let inverse = &inverses[k];
            let file_name = info.file.file_name().unwrap_or_default().to_string_lossy().to_string();
            rep.phase("scan", layer.as_str(), &file_name, k + 1, files.len());
            let total = texts[k].len() as u64;
            let mut last_bucket = usize::MAX;
            let mut seen: u64 = 0;
            let mut cancelled = false;
            rows::for_each_row(&texts[k], info.delimiter, |_, record, bytes| {
                if record.len() != info.headers.len() {
                    return true; // rejeito conta na fase B
                }
                phase.feed(record, inverse);
                seen += 1;
                if seen % 2048 == 0 && opts.cancel.as_ref().map(|c| c.load(Ordering::Relaxed)).unwrap_or(false) {
                    cancelled = true;
                    return false;
                }
                let bucket = if total > 0 { (bytes * 20 / total) as usize } else { 20 };
                if bucket != last_bucket {
                    last_bucket = bucket;
                    rep.progress(true, layer.as_str(), &file_name, bytes, total);
                }
                true
            });
            if cancelled {
                return Err(BuildError::Cancelled);
            }
        }
        let dict_columns = phase.finish();
        rep.log(format!(
            "{}: {} coluna(s) em dicionário de {}",
            layer.as_str(),
            dict_columns.len(),
            ncols
        ));
        let mut dict_index: HashMap<usize, HashMap<String, i64>> = HashMap::new();
        for (c, values) in &dict_columns {
            dict_index.insert(
                *c,
                values
                    .iter()
                    .enumerate()
                    .map(|(code, v)| (v.clone(), code as i64))
                    .collect(),
            );
        }

        // ---- DDL ----
        let col_defs: Vec<String> = headers
            .iter()
            .enumerate()
            .map(|(c, h)| {
                if dict_columns.contains_key(&c) {
                    format!("{} INTEGER", quote_ident(h))
                } else {
                    format!("{} TEXT", quote_ident(h))
                }
            })
            .collect();
        let t = quote_ident(layer.as_str());
        let rt = quote_ident(&format!("rtree_{}", layer.as_str()));
        db.execute_batch(&format!(
            "DROP TABLE IF EXISTS {t};
             CREATE TABLE {t} (
               \"_rid\" INTEGER PRIMARY KEY, \"_id\" TEXT, \"_lon\" REAL, \"_lat\" REAL,
               \"_min_lon\" REAL, \"_max_lon\" REAL, \"_min_lat\" REAL, \"_max_lat\" REAL,
               \"_geom\" BLOB, {cols}
             );
             DROP TABLE IF EXISTS {rt};
             CREATE VIRTUAL TABLE {rt} USING rtree(\"id\", \"min_lon\", \"max_lon\", \"min_lat\", \"max_lat\");",
            cols = col_defs.join(", ")
        ))
        .map_err(|e| format!("DDL {}: {e}", layer.as_str()))?;
        let all_cols: Vec<String> = ["_rid", "_id", "_lon", "_lat", "_min_lon", "_max_lon", "_min_lat", "_max_lat", "_geom"]
            .iter()
            .map(|c| quote_ident(c))
            .chain(headers.iter().map(|h| quote_ident(h)))
            .collect();
        let placeholders = vec!["?"; all_cols.len()].join(",");
        let insert_sql = format!("INSERT INTO {t} ({}) VALUES ({placeholders})", all_cols.join(","));
        let rtree_sql = format!("INSERT INTO {rt} VALUES (?, ?, ?, ?, ?)");

        // indices das colunas de stats na uniao
        let find = |name: &str| {
            headers
                .iter()
                .position(|h| h == name)
                .map(|i| i as isize)
                .unwrap_or(-1)
        };
        let material_idx = {
            let m = find("MATERIAL");
            if m >= 0 { m } else { find("CD_INDD_MATERIAL_PG_DESC") }
        };
        let poletype_idx = {
            let m = find("TIPO_PG");
            if m >= 0 { m } else { find("CD_TIPO_PG_DESC") }
        };
        let insttype_idx = {
            let m = find("TIPO_INSTA");
            if m >= 0 {
                m
            } else {
                let s = find("TIPO_SIGLA");
                if s >= 0 { s } else { find("NU_TIPO_INSTALACAO_MT_ID_DESC") }
            }
        };
        let conductor_idx = {
            let m = find("CONDUTOR_A");
            if m >= 0 { m } else { find("CONDUTOR_N") }
        };

        let mut stats = crate::stats::Stats::new();
        let mut layer_rejects: u64 = 0;
        let mut rid: i64 = 0;

        // ---- Fase B ----
        rep.log(format!("{}: fase B (carga)…", layer.as_str()));
        // Buffers reutilizados entre linhas (zero alloc no caminho quente).
        let null = Value::Null;
        let mut code_buf: Vec<Option<i64>> = vec![None; ncols];
        for (k, &fi) in files.iter().enumerate() {
            check_cancel(&opts.cancel)?;
            let info = &infos[fi];
            let text = &texts[k];
            let inverse = &inverses[k];
            let file_name = info.file.file_name().unwrap_or_default().to_string_lossy().to_string();
            rep.phase("load", layer.as_str(), &file_name, k + 1, files.len());
            let total = text.len() as u64;
            let tx = db.transaction().map_err(|e| format!("BEGIN: {e}"))?;
            let completed: bool;
            let (file_rows, file_rejects) = {
                let mut ins = tx.prepare(&insert_sql).map_err(|e| format!("prepare: {e}"))?;
                let mut ins_rt = tx.prepare(&rtree_sql).map_err(|e| format!("prepare rtree: {e}"))?;
                let mut ins_rej = tx
                    .prepare("INSERT INTO \"_rejects\" (\"layer\", \"file\", \"line\", \"reason\", \"content\") VALUES (?, ?, ?, ?, ?)")
                    .map_err(|e| format!("prepare rejects: {e}"))?;
                let mut file_rows: u64 = 0;
                let mut file_rejects: u64 = 0;
                let mut err: Option<String> = None;
                let mut seen: u64 = 0;
                let mut last_bucket = usize::MAX;
                completed = rows::for_each_row(text, info.delimiter, |line_no, record, bytes| {
                    if err.is_some() {
                        return false;
                    }
                    seen += 1;
                    if seen % 2048 == 0 && opts.cancel.as_ref().map(|c| c.load(Ordering::Relaxed)).unwrap_or(false) {
                        return false;
                    }
                    if let Err(e) = feed_row(
                        &mut ins,
                        &mut ins_rt,
                        &mut ins_rej,
                        &null,
                        &mut code_buf,
                        layer,
                        info,
                        line_no,
                        record,
                        inverse,
                        ncols,
                        &ix,
                        &dict_index,
                        material_idx,
                        poletype_idx,
                        insttype_idx,
                        conductor_idx,
                        &mut stats,
                        &mut rid,
                        &mut file_rows,
                        &mut file_rejects,
                        &mut layer_rejects,
                        &mut rejects_total,
                        &mut rejects_sample,
                    ) {
                        err = Some(e);
                        return false;
                    }
                    let bucket = if total > 0 { (bytes * 20 / total) as usize } else { 20 };
                    if bucket != last_bucket {
                        last_bucket = bucket;
                        rep.progress(false, layer.as_str(), &file_name, bytes, total);
                    }
                    true
                });
                if let Some(e) = err {
                    return Err(BuildError::Failed(e));
                }
                if !completed {
                    // Abortado: desfaz o arquivo parcial (o JS faz ROLLBACK no erro).
                    drop(ins);
                    drop(ins_rt);
                    drop(ins_rej);
                    tx.rollback().map_err(|e| format!("ROLLBACK: {e}"))?;
                    return Err(BuildError::Cancelled);
                }
                (file_rows, file_rejects)
            };
            tx.commit().map_err(|e| format!("COMMIT: {e}"))?;
            manifest_files.push(sj::ManifestFile {
                file: rel(source, &info.file),
                layer: layer.as_str().to_string(),
                bytes: info.size,
                rows: file_rows,
                rejects: file_rejects,
                encoding: info.encoding.as_str().to_string(),
                delimiter: info.delimiter.to_string(),
                header_columns: info.headers.len(),
                conflict: info.conflict,
                headers: Vec::new(), // preenchido no fim (espelha o JS)
            });
            rep.log(format!(
                "{}: {} -> {} linhas ({}, delim {:?}) · total {}",
                layer.as_str(),
                info.file.file_name().unwrap_or_default().to_string_lossy(),
                fmt_int(file_rows as f64),
                info.encoding.as_str(),
                info.delimiter.to_string(),
                fmt_int(stats.count as f64),
            ));
        }

        // ---- meta da camada ----
        // Ordem dos headers (como o objeto JS) para paridade byte-a-byte.
        let mut dict_meta: indexmap::IndexMap<String, Vec<String>> = indexmap::IndexMap::new();
        for h in headers {
            if let Some(c) = union_index.get(h.as_str()).copied() {
                if let Some(values) = dict_columns.get(&c) {
                    dict_meta.insert(h.clone(), values.clone());
                }
            }
        }
        let bounds = if stats.has_bounds() {
            Some(sj::Bounds {
                west: stats.west,
                south: stats.south,
                east: stats.east,
                north: stats.north,
            })
        } else {
            None
        };
        layers_meta.push(sj::LayerMeta {
            layer_type: layer.as_str().to_string(),
            name: layers::layer_title(layer).to_string(),
            headers: headers.clone(),
            count: stats.count,
            located: stats.located,
            missing: stats.missing,
            duplicates: stats.duplicates,
            id_present: stats.id_present,
            length_meters: stats.length_meters,
            material: stats.material.top(),
            pole_type: stats.pole_type.top(),
            installation_type: stats.installation_type.top(),
            conductor: stats.conductor.top(),
            dicts: dict_meta,
            bounds,
            hotspots: stats
                .hotspots_top()
                .into_iter()
                .map(|(cx, cy, count)| sj::Hotspot { cx, cy, count })
                .collect(),
            indexes: sj::SchemaIndexes {
                id: ix.id,
                lon: ix.lon,
                lat: ix.lat,
                wkt: ix.wkt,
                angle: ix.angle,
                start_pole: ix.start_pole,
                end_pole: ix.end_pole,
                pole: ix.pole,
                length: ix.length,
            },
        });
        manifest_layers.insert(
            layer.as_str().to_string(),
            sj::ManifestLayer {
                rows: stats.count,
                located: stats.located,
                missing: stats.missing,
                duplicates: stats.duplicates,
                rejects: layer_rejects,
                headers: ncols,
                dict_columns: dict_columns.len(),
                files: files
                    .iter()
                    .map(|&fi| rel(source, &infos[fi].file))
                    .collect(),
            },
        );
        layer_rows.insert(layer.as_str(), stats.count);
        layer_located.insert(layer.as_str(), stats.located);
        layer_length.insert(layer.as_str(), stats.length_meters);
        stats.clear_transient();
        rep.log(format!(
            "{}: {} registros · {} localizados · {:.1} km",
            layer.as_str(),
            fmt_int(stats.count as f64),
            fmt_int(stats.located as f64),
            stats.length_meters / 1000.0
        ));
    }

    // ---- Vinculos ----
    rep.log("Montando vínculos poste↔instalação/rede…".to_string());
    let mut link_counts = sj::LinkCounts { inst: 0, nets: 0 };
    build_links(db, &layers_meta, &mut link_counts)?;
    rep.log(format!(
        "Vínculos: {} instalação↔poste · {} trecho↔poste",
        fmt_int(link_counts.inst as f64),
        fmt_int(link_counts.nets as f64)
    ));

    // ---- Indices ----
    rep.log("Criando índices…".to_string());
    for layer in &layers_meta {
        db.execute_batch(&format!(
            "CREATE INDEX {} ON {} (\"_id\");
             CREATE INDEX {} ON {} (\"_lon\", \"_lat\");",
            quote_ident(&format!("idx_{}_id", layer.layer_type)),
            quote_ident(&layer.layer_type),
            quote_ident(&format!("idx_{}_lonlat", layer.layer_type)),
            quote_ident(&layer.layer_type),
        ))
        .map_err(|e| format!("indices {}: {e}", layer.layer_type))?;
    }

    let total_rows: u64 = layer_rows.values().sum();
    let total_located: u64 = layer_located.values().sum();
    let total_length: f64 = layer_length.values().sum();
    let schema = sj::Schema {
        format: "neogrid-sqlite".to_string(),
        version: 2,
        built_at: now_ms(),
        source: source.to_string_lossy().to_string(),
        rows: total_rows,
        located: total_located,
        total_length,
        layers: layers_meta,
        links: sj::LinkCounts {
            inst: link_counts.inst,
            nets: link_counts.nets,
        },
        rejects: rejects_total,
        imports: manifest_files.clone(),
    };
    let schema_json = serde_json::to_string(&schema).map_err(|e| format!("schema json: {e}"))?;
    db.execute(
        "INSERT OR REPLACE INTO meta (\"key\", \"value\") VALUES (?, ?)",
        rusqlite::params!["schema", schema_json],
    )
    .map_err(|e| format!("meta: {e}"))?;
    db.execute_batch("PRAGMA journal_mode = DELETE; PRAGMA optimize;")
        .map_err(|e| format!("finalize: {e}"))?;
    // Fecha antes de medir o arquivo.
    // (o `db` e fechado pelo chamador via drop; checkpoint aqui)
    db.execute_batch("PRAGMA wal_checkpoint(TRUNCATE);").ok();

    let output_bytes = std::fs::metadata(&opts.output)
        .map(|m| m.len())
        .unwrap_or(0);

    // headers por arquivo no manifesto (espelha o JS)
    for item in manifest_files.iter_mut() {
        if let Some(info) = infos
            .iter()
            .find(|i| rel(source, &i.file) == item.file)
        {
            item.headers = info.headers.clone();
        }
    }

    let mut manifest = sj::Manifest {
        format: "neogrid-build-manifest".to_string(),
        version: 1,
        built_at: now_ms(),
        source: source.to_string_lossy().to_string(),
        output: opts.output.to_string_lossy().to_string(),
        reject_limit: opts.reject_limit,
        layers: manifest_layers,
        files: manifest_files,
        rejects_total,
        rejects_sample,
        rows: Some(total_rows),
        located: Some(total_located),
        total_length: Some(total_length),
        links: Some(sj::LinkCounts {
            inst: link_counts.inst,
            nets: link_counts.nets,
        }),
        output_bytes: Some(output_bytes),
        previous: None,
        new_columns: None,
    };

    // ---- Comparacao com o mes anterior ----
    if let Some(base) = &opts.manifesto_base {
        if base.exists() {
            match compare_manifest(base, &mut manifest, infos, source, by_layer) {
                Ok(lines) => {
                    for line in lines {
                        rep.log(line);
                    }
                }
                Err(e) => rep.log(format!("AVISO: não foi possível comparar manifestos: {e}")),
            }
        }
    }

    let manifesto_path = opts
        .manifesto_out
        .clone()
        .unwrap_or_else(|| PathBuf::from(format!("{}.manifesto.json", opts.output.display())));
    let manifesto_text =
        serde_json::to_string_pretty(&manifest).map_err(|e| format!("manifesto json: {e}"))?;
    std::fs::write(&manifesto_path, manifesto_text).map_err(|e| format!("gravar manifesto: {e}"))?;
    rep.log(format!("Manifesto: {}", manifesto_path.display()));

    let reject_share = if total_rows > 0 {
        rejects_total as f64 / total_rows as f64
    } else {
        0.0
    };
    if reject_share > opts.reject_limit {
        return Err(BuildError::Failed(format!(
            "Rejeitos acima do limite: {} ({:.2}% > {:.2}%). Banco descartado; verifique o manifesto.",
            fmt_int(rejects_total as f64),
            reject_share * 100.0,
            opts.reject_limit * 100.0
        )));
    }

    rep.log(format!("Banco criado: {}", opts.output.display()));
    rep.log(format!("Tamanho: {:.1} MB", output_bytes as f64 / 1024.0 / 1024.0));
    rep.log(format!(
        "{} registros · {} localizados · {:.1} km · rejeitos {} · {} s",
        fmt_int(total_rows as f64),
        fmt_int(total_located as f64),
        total_length / 1000.0,
        fmt_int(rejects_total as f64),
        (now_ms() - started) / 1000
    ));

    Ok(BuildResult {
        output: opts.output.clone(),
        manifesto_out: manifesto_path,
        rows: total_rows,
        manifest: serde_json::to_value(&manifest).map_err(|e| format!("manifesto value: {e}"))?,
    })
}

#[allow(clippy::too_many_arguments)]
fn feed_row(
    ins: &mut rusqlite::Statement,
    ins_rt: &mut rusqlite::Statement,
    ins_rej: &mut rusqlite::Statement,
    null: &Value,
    code_buf: &mut Vec<Option<i64>>,
    layer: Layer,
    info: &FileInfo,
    line_no: u64,
    record: &csv::StringRecord,
    inverse: &[Option<usize>],
    ncols: usize,
    ix: &LayerIndexes,
    dict_index: &HashMap<usize, HashMap<String, i64>>,
    material_idx: isize,
    poletype_idx: isize,
    insttype_idx: isize,
    conductor_idx: isize,
    stats: &mut crate::stats::Stats,
    rid: &mut i64,
    file_rows: &mut u64,
    file_rejects: &mut u64,
    layer_rejects: &mut u64,
    rejects_total: &mut u64,
    rejects_sample: &mut Vec<sj::RejectSample>,
) -> Result<(), String> {
    if record.len() != info.headers.len() {
        *file_rejects += 1;
        *layer_rejects += 1;
        *rejects_total += 1;
        let content: String = record.iter().collect::<Vec<_>>().join(";").chars().take(2000).collect();
        ins_rej
            .execute(rusqlite::params![
                layer.as_str(),
                info.file
                    .file_name()
                    .unwrap_or_default()
                    .to_string_lossy()
                    .to_string(),
                line_no as i64,
                format!(
                    "colunas {} ≠ {} do cabeçalho",
                    record.len(),
                    info.headers.len()
                ),
                content
            ])
            .map_err(|e| format!("reject: {e}"))?;
        if rejects_sample.len() < 50 {
            rejects_sample.push(sj::RejectSample {
                layer: layer.as_str().to_string(),
                file: info
                    .file
                    .file_name()
                    .unwrap_or_default()
                    .to_string_lossy()
                    .to_string(),
                line: line_no,
                reason: format!(
                    "colunas {} ≠ {} do cabeçalho",
                    record.len(),
                    info.headers.len()
                ),
            });
        }
        return Ok(());
    }

    // Celula da uniao como &str emprestado (zero clone).
    let cell = |c: usize| -> &str {
        match inverse.get(c).copied().flatten() {
            Some(s) => record.get(s).unwrap_or(""),
            None => "",
        }
    };
    let at = |i: isize| -> &str {
        if i >= 0 { cell(i as usize) } else { "" }
    };
    let id = at(ix.id).trim();
    let length = to_number_opt(at(ix.length));
    let mut lon = to_number_opt(at(ix.lon));
    let mut lat = to_number_opt(at(ix.lat));
    let geometry = at(ix.wkt);
    let mut bbox: Option<wkt::WktScan> = None;
    // O WKT e a posicao autoritativa (defasagem NU_LONGITUDE/NU_LATITUDE).
    if !geometry.is_empty() {
        bbox = wkt::scan_wkt(geometry);
        if let Some(b) = &bbox {
            lon = Some(b.first_lon);
            lat = Some(b.first_lat);
        } else if layer == Layer::Poste {
            if let (Some(x), Some(y)) = (lon, lat) {
                bbox = Some(wkt::WktScan {
                    first_lon: x,
                    first_lat: y,
                    min_lon: x,
                    min_lat: y,
                    max_lon: x,
                    max_lat: y,
                });
            }
        }
    } else if let (Some(x), Some(y)) = (lon, lat) {
        bbox = Some(wkt::WktScan {
            first_lon: x,
            first_lat: y,
            min_lon: x,
            min_lat: y,
            max_lon: x,
            max_lat: y,
        });
    }
    let has_point = matches!((lon, lat), (Some(_), Some(_)));

    // Array de celulas emprestadas (vive ate o execute; um vec de ptrs/linha).
    let cells: Vec<&str> = (0..ncols).map(|c| cell(c)).collect();

    // Passada 1: resolve codigos do dicionario (sem emprestimos ativos).
    code_buf.fill(None);
    for c in 0..ncols {
        if let Some(map) = dict_index.get(&c) {
            let v = cells[c];
            if !v.is_empty() {
                if let Some(code) = map.get(v) {
                    code_buf[c] = Some(*code);
                }
                // Ausente no mapa: mesma linha foi vista na fase A, entao nao
                // ocorre; se ocorrer, cai no texto original abaixo.
            }
        }
    }

    // Passada 2: monta os parametros como emprestimos (vec local: o tempo de
    // vida e so ate o execute abaixo).
    let mut params: Vec<&dyn rusqlite::ToSql> = Vec::with_capacity(9 + ncols);
    let rid_v = *rid;
    params.push(&rid_v);
    let id_opt: Option<&str> = if id.is_empty() { None } else { Some(id) };
    params.push(&id_opt);
    params.push(&lon);
    params.push(&lat);
    let min_lon = bbox.map(|b| b.min_lon);
    let max_lon = bbox.map(|b| b.max_lon);
    let min_lat = bbox.map(|b| b.min_lat);
    let max_lat = bbox.map(|b| b.max_lat);
    params.push(&min_lon);
    params.push(&max_lon);
    params.push(&min_lat);
    params.push(&max_lat);
    let geom_blob: Option<Vec<u8>>;
    // `&&str` -> `&dyn ToSql` (str e unsized, precisa da dupla referencia).
    let geom_text = geometry;
    match geom::encode_geometry(geometry) {
        geom::GeomValue::Null => params.push(null),
        geom::GeomValue::Short => params.push(&geom_text),
        geom::GeomValue::Blob(b) => {
            geom_blob = Some(b);
            params.push(geom_blob.as_ref().unwrap());
        }
    }
    // Stats usam a celula CODIFICADA como string (paridade com o JS).
    // Para nao alocar por celula, resolve sob demanda no bump.
    for c in 0..ncols {
        if dict_index.contains_key(&c) {
            match code_buf[c] {
                Some(_) => params.push(&code_buf[c]),
                None => {
                    let v = cells[c];
                    if v.is_empty() {
                        params.push(null);
                    } else {
                        params.push(&cells[c]);
                    }
                }
            }
        } else {
            params.push(&cells[c]);
        }
    }

    ins.execute(params_from_iter(params.iter().copied()))
        .map_err(|e| format!("insert {}: {e}", layer.as_str()))?;
    if let Some(b) = bbox {
        ins_rt
            .execute(rusqlite::params![rid_v, b.min_lon, b.max_lon, b.min_lat, b.max_lat])
            .map_err(|e| format!("rtree: {e}"))?;
        stats.hotspot(b.first_lon, b.first_lat);
        stats.bound(b.min_lon, b.min_lat);
        stats.bound(b.max_lon, b.max_lat);
    }
    stats.count += 1;
    if has_point {
        stats.located += 1;
    } else {
        stats.missing += 1;
    }
    if let Some(l) = length {
        stats.length_meters += l;
    }
    if !id.is_empty() {
        stats.register_id(id);
    }
    // Bump com a forma codificada (codigo ou texto), como o JS.
    let encoded_bump = |c: isize| -> Option<String> {
        if c < 0 {
            return None;
        }
        let c = c as usize;
        if dict_index.contains_key(&c) {
            match code_buf[c] {
                Some(code) => Some(code.to_string()),
                None => {
                    let v = cell(c);
                    if v.is_empty() {
                        None
                    } else {
                        Some(v.to_string())
                    }
                }
            }
        } else {
            let v = cell(c);
            if v.trim().is_empty() {
                None
            } else {
                Some(v.to_string())
            }
        }
    };
    let kind = layer.as_str();
    if kind == "poste" {
        // `bump` mapeia vazio -> "Não informado"; aqui None ja trata.
        match encoded_bump(material_idx) {
            Some(v) => stats.material.bump(&v),
            None => stats.material.bump(""),
        }
        match encoded_bump(poletype_idx) {
            Some(v) => stats.pole_type.bump(&v),
            None => stats.pole_type.bump(""),
        }
    } else if kind == "inst" {
        match encoded_bump(insttype_idx) {
            Some(v) => stats.installation_type.bump(&v),
            None => stats.installation_type.bump(""),
        }
    } else if conductor_idx >= 0 {
        match encoded_bump(conductor_idx) {
            Some(v) => stats.conductor.bump(&v),
            None => stats.conductor.bump(""),
        }
    }
    *rid += 1;
    *file_rows += 1;
    Ok(())
}

/// Resolve o texto de uma celula lida do banco (decodifica dicionario).
fn cell_text(
    value: &Value,
    dicts: &indexmap::IndexMap<String, Vec<String>>,
    header: &str,
) -> String {
    match value {
        Value::Null => String::new(),
        Value::Integer(code) => {
            if let Some(list) = dicts.get(header) {
                list.get(*code as usize).cloned().unwrap_or_default()
            } else {
                code.to_string()
            }
        }
        Value::Real(f) => {
            if f.fract() == 0.0 {
                format!("{}", *f as i64)
            } else {
                format!("{}", f)
            }
        }
        Value::Text(t) => t.clone(),
        Value::Blob(_) => String::new(),
    }
}

fn build_links(
    db: &mut Connection,
    layers_meta: &[sj::LayerMeta],
    counts: &mut sj::LinkCounts,
) -> Result<(), String> {
    db.execute_batch(
        "DROP TABLE IF EXISTS \"_link_pole_inst\";
         DROP TABLE IF EXISTS \"_link_pole_net\";
         CREATE TABLE \"_link_pole_inst\" (\"pole\" TEXT, \"inst_rid\" INTEGER);
         CREATE TABLE \"_link_pole_net\" (\"pole\" TEXT, \"layer\" TEXT, \"net_rid\" INTEGER);",
    )
    .map_err(|e| format!("links ddl: {e}"))?;

    let meta_of = |t: &str| layers_meta.iter().find(|l| l.layer_type == t);
    let pole_col = |t: &str, candidates: &[&str]| -> Option<String> {
        let layer = meta_of(t)?;
        for name in candidates {
            if layer.headers.iter().any(|h| h == name) {
                return Some(name.to_string());
            }
        }
        None
    };

    let tx = db.transaction().map_err(|e| format!("links BEGIN: {e}"))?;
    {
        let mut ins_inst = tx
            .prepare("INSERT INTO \"_link_pole_inst\" VALUES (?, ?)")
            .map_err(|e| format!("links prepare: {e}"))?;
        let mut ins_net = tx
            .prepare("INSERT INTO \"_link_pole_net\" VALUES (?, ?, ?)")
            .map_err(|e| format!("links prepare: {e}"))?;

        if let Some(col) = pole_col("inst", &["NU_PG_ID"]) {
            let layer = meta_of("inst").unwrap();
            let dicts: indexmap::IndexMap<String, Vec<String>> = layer.dicts.clone();
            let sql = format!("SELECT \"_rid\", {} FROM \"inst\"", quote_ident(&col));
            let mut sel = tx.prepare(&sql).map_err(|e| format!("links select: {e}"))?;
            let rows = sel
                .query_map([], |r| {
                    let rid: i64 = r.get(0)?;
                    let v: Value = r.get(1)?;
                    Ok((rid, v))
                })
                .map_err(|e| format!("links query: {e}"))?;
            for row in rows {
                let (rid, v) = row.map_err(|e| format!("links row: {e}"))?;
                let key = cell_text(&v, &dicts, &col).trim().to_string();
                if key.is_empty() {
                    continue;
                }
                ins_inst
                    .execute(rusqlite::params![key, rid])
                    .map_err(|e| format!("links insert: {e}"))?;
                counts.inst += 1;
            }
        }
        for layer_type in ["bt", "mt"] {
            let (start, end) = (
                pole_col(layer_type, &["NU_PG_INICIAL_ID", "NU_PG_INI"]),
                pole_col(layer_type, &["NU_PG_FINAL_ID", "NU_PG_FIN"]),
            );
            if start.is_none() && end.is_none() {
                continue;
            }
            let layer = meta_of(layer_type).unwrap();
            let dicts: indexmap::IndexMap<String, Vec<String>> = layer.dicts.clone();
            let mut cols = vec!["\"_rid\"".to_string()];
            if let Some(c) = &start {
                cols.push(format!("{} AS p0", quote_ident(c)));
            }
            if let Some(c) = &end {
                if Some(c) != start.as_ref() {
                    cols.push(format!("{} AS p1", quote_ident(c)));
                }
            }
            let sql = format!("SELECT {} FROM {}", cols.join(", "), quote_ident(layer_type));
            let mut sel = tx.prepare(&sql).map_err(|e| format!("links select: {e}"))?;
            let ncols_out = 1 + (if start.is_some() { 1 } else { 0 })
                + (if end.is_some() && end != start { 1 } else { 0 });
            let rows = sel
                .query_map([], |r| {
                    let mut vals: Vec<Value> = Vec::with_capacity(ncols_out);
                    for i in 0..ncols_out {
                        vals.push(r.get(i)?);
                    }
                    Ok(vals)
                })
                .map_err(|e| format!("links query: {e}"))?;
            let names: Vec<String> = {
                let mut v = Vec::new();
                if let Some(c) = &start {
                    v.push(c.clone());
                }
                if let Some(c) = &end {
                    if Some(c) != start.as_ref() {
                        v.push(c.clone());
                    }
                }
                v
            };
            for row in rows {
                let vals = row.map_err(|e| format!("links row: {e}"))?;
                let rid = match &vals[0] {
                    Value::Integer(i) => *i,
                    _ => continue,
                };
                for (k, name) in vals.iter().skip(1).zip(names.iter()) {
                    let key = cell_text(k, &dicts, name).trim().to_string();
                    if key.is_empty() {
                        continue;
                    }
                    ins_net
                        .execute(rusqlite::params![key, layer_type, rid])
                        .map_err(|e| format!("links insert: {e}"))?;
                    counts.nets += 1;
                }
            }
        }
    }
    tx.commit().map_err(|e| format!("links COMMIT: {e}"))?;
    db.execute_batch(
        "CREATE INDEX \"_link_pole_inst_idx\" ON \"_link_pole_inst\" (\"pole\");
         CREATE INDEX \"_link_pole_net_idx\" ON \"_link_pole_net\" (\"pole\");",
    )
    .map_err(|e| format!("links index: {e}"))?;
    Ok(())
}

/// Comparacao com o manifesto anterior (espelha o JS): preenche `previous` e
/// `newColumns`, retorna linhas de log.
fn compare_manifest(
    base_path: &Path,
    manifest: &mut sj::Manifest,
    infos: &[FileInfo],
    source: &Path,
    by_layer: &HashMap<&'static str, Vec<usize>>,
) -> Result<Vec<String>, String> {
    let raw = std::fs::read_to_string(base_path).map_err(|e| format!("ler base: {e}"))?;
    let base: serde_json::Value =
        serde_json::from_str(&raw).map_err(|e| format!("parse base: {e}"))?;
    let mut lines = Vec::new();

    let layer_stat = |layers_obj: &serde_json::Value, t: &str| -> Option<(u64, u64, u64)> {
        let l = layers_obj.get(t)?;
        Some((
            l.get("rows").and_then(|v| v.as_u64()).unwrap_or(0),
            l.get("headers").and_then(|v| v.as_u64()).unwrap_or(0),
            l.get("rejects").and_then(|v| v.as_u64()).unwrap_or(0),
        ))
    };
    let current: serde_json::Value = serde_json::to_value(&manifest.layers)
        .map_err(|e| format!("serializar camadas: {e}"))?;
    let mut deltas = serde_json::Map::new();
    for t in ["poste", "bt", "mt", "inst"] {
        // `base.layers` e `current` sao mapas {tipo: {...}}.
        let b = base.get("layers").and_then(|o| layer_stat(o, t));
        let a = layer_stat(&current, t);
        if let (Some((br, bh, _)), Some((ar, ah, rej))) = (b, a) {
            deltas.insert(
                t.to_string(),
                serde_json::json!({
                    "rows": (ar as i64) - (br as i64),
                    "headers": (ah as i64) - (bh as i64),
                    "rejects": rej,
                }),
            );
        }
    }
    let base_rows = base.get("rows").and_then(|v| v.as_u64()).unwrap_or(0);
    let now_rows = manifest.rows.unwrap_or(0);
    let base_files: HashSet<String> = base
        .get("files")
        .and_then(|v| v.as_array())
        .map(|a| {
            a.iter()
                .filter_map(|f| {
                    f.get("file").and_then(|v| v.as_str()).map(|s| s.to_string())
                })
                .collect()
        })
        .unwrap_or_default();
    let now_files: HashSet<String> = manifest.files.iter().map(|f| f.file.clone()).collect();
    let mut new_files: Vec<String> = now_files.difference(&base_files).cloned().collect();
    let mut missing: Vec<String> = base_files.difference(&now_files).cloned().collect();
    new_files.sort();
    missing.sort();
    lines.push(format!(
        "Mês anterior: {} registros → agora {} (Δ {})",
        fmt_int(base_rows as f64),
        fmt_int(now_rows as f64),
        fmt_int(now_rows as f64 - base_rows as f64)
    ));
    if !new_files.is_empty() {
        lines.push(format!("Arquivos novos: {}", new_files.join(", ")));
    }
    if !missing.is_empty() {
        lines.push(format!("Arquivos ausentes: {}", missing.join(", ")));
    }
    manifest.previous = Some(serde_json::json!({
        "builtAt": base.get("builtAt").cloned().unwrap_or(serde_json::Value::Null),
        "rows": base_rows,
        "deltas": deltas,
        "newFiles": new_files,
        "missingFiles": missing,
    }));

    // Colunas novas por camada.
    let mut new_columns: HashMap<String, sj::ColumnDiff> = HashMap::new();
    for t in ["poste", "bt", "mt", "inst"] {
        let mut before: HashSet<String> = HashSet::new();
        if let Some(files) = base.get("files").and_then(|v| v.as_array()) {
            for f in files {
                if f.get("layer").and_then(|v| v.as_str()) != Some(t) {
                    continue;
                }
                if let Some(hdrs) = f.get("headers").and_then(|v| v.as_array()) {
                    for h in hdrs {
                        if let Some(s) = h.as_str() {
                            before.insert(s.to_string());
                        }
                    }
                }
            }
        }
        if before.is_empty() {
            continue;
        }
        let mut now: HashSet<String> = HashSet::new();
        if let Some(list) = by_layer.get(t) {
            for &fi in list {
                let _ = source; // (rel ja resolvido nos itens do manifesto)
                for h in &infos[fi].headers {
                    now.insert(h.clone());
                }
            }
        }
        let mut added: Vec<String> = now.difference(&before).cloned().collect();
        let mut removed: Vec<String> = before.difference(&now).cloned().collect();
        added.sort();
        removed.sort();
        if !added.is_empty() || !removed.is_empty() {
            new_columns.insert(t.to_string(), sj::ColumnDiff { added, removed });
        }
    }
    if !new_columns.is_empty() {
        manifest.new_columns = Some(new_columns);
    }
    Ok(lines)
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Cancelamento pré-armado: falha rápido com `Cancelled` e remove o banco.
    #[test]
    fn cancel_aborts_and_removes_output() {
        let dir = std::env::temp_dir().join(format!("neogrid-cancel-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        std::fs::write(
            dir.join("postes_teste.csv"),
            "NU_PG_ID;GEO_X;GEO_Y;NU_ALTURA;NU_ESFORCO;DE_BARRAMEN;TIPO_PG\n".to_string()
                + &(0..3000)
                    .map(|i| format!("{i};-39.36;-8.28;12;300;X{i};Duplo T\n"))
                    .collect::<String>(),
        )
        .unwrap();
        let output = dir.join("out.sqlite");
        let cancel = Arc::new(AtomicBool::new(true)); // já cancelado
        let events = Arc::new(MutexCollector::new());
        let events_clone = events.clone();
        let opts = Options {
            source: dir.clone(),
            output: output.clone(),
            manifesto_base: None,
            manifesto_out: Some(dir.join("m.json")),
            reject_limit: 0.005,
            cancel: Some(cancel),
            on_progress: Some(Arc::new(move |e| events_clone.push(e))),
        };
        let result = build_database(&opts);
        assert!(matches!(result, Err(BuildError::Cancelled)), "got: {result:?}");
        assert!(!output.exists(), "banco parcial deve ser removido");
        let _ = std::fs::remove_dir_all(&dir);
        let _ = events;
    }

    /// Progresso emite Log + Phase + Progress sobre a amostra.
    #[test]
    fn progress_events_flow() {
        use std::sync::Mutex;
        let events: Arc<Mutex<Vec<String>>> = Arc::new(Mutex::new(Vec::new()));
        let ec = events.clone();
        let testdata = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("..").join("testdata");
        if !testdata.exists() {
            return; // amostra opcional
        }
        let dir = std::env::temp_dir().join(format!("neogrid-prog-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        let opts = Options {
            source: testdata,
            output: dir.join("out.sqlite"),
            manifesto_base: None,
            manifesto_out: Some(dir.join("m.json")),
            reject_limit: 0.005,
            cancel: None,
            on_progress: Some(Arc::new(move |e| {
                ec.lock().unwrap().push(match e {
                    ProgressEvent::Log(_) => "log",
                    ProgressEvent::Phase { .. } => "phase",
                    ProgressEvent::Progress { scan, .. } => {
                        if scan {
                            "scan"
                        } else {
                            "load"
                        }
                    }
                }.to_string());
            })),
        };
        let result = build_database(&opts);
        assert!(result.is_ok(), "got: {result:?}");
        let kinds: std::collections::HashSet<String> =
            events.lock().unwrap().iter().cloned().collect();
        assert!(kinds.contains("log"), "faltou log: {kinds:?}");
        assert!(kinds.contains("phase"), "faltou phase: {kinds:?}");
        assert!(kinds.contains("scan"), "faltou scan: {kinds:?}");
        assert!(kinds.contains("load"), "faltou load: {kinds:?}");
        let _ = std::fs::remove_dir_all(&dir);
    }

    struct MutexCollector {
        inner: std::sync::Mutex<Vec<ProgressEvent>>,
    }

    impl MutexCollector {
        fn new() -> Self {
            Self { inner: std::sync::Mutex::new(Vec::new()) }
        }

        fn push(&self, e: ProgressEvent) {
            self.inner.lock().unwrap().push(e);
        }
    }
}
