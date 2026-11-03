//! Commands Tauri — mesma superficie do `preload.js` + `database.js` do Electron.
//!
//! Convenções espelhadas:
//! - `db_query(channel, payload)` retorna `{ok, result?/error?}`.
//! - buffers binários trafegam em base64 (igual ao IPC do Electron).
//! - progresso do build emite `db:build-progress` nos formatos que o
//!   `db-build-ui.js` já entende.

use tauri::{Emitter as _, Manager as _};

use neogrid_build::{build_database, BuildError, Options, ProgressEvent};
use neogrid_query::Manager;
use std::path::PathBuf;
use std::sync::{
    atomic::{AtomicBool, Ordering},
    Arc, Mutex,
};

pub struct DbState(pub Mutex<Option<Manager>>);

pub struct BuildState {
    pub running: Mutex<bool>,
    pub cancel: Mutex<Option<Arc<AtomicBool>>>,
}

impl Default for BuildState {
    fn default() -> Self {
        Self {
            running: Mutex::new(false),
            cancel: Mutex::new(None),
        }
    }
}

fn sanitize_name(name: &str, fallback: &str) -> String {
    let clean: String = name
        .chars()
        .map(|c| {
            if matches!(c, '<' | '>' | ':' | '"' | '/' | '\\' | '|' | '?' | '*') || c.is_control() {
                '-'
            } else {
                c
            }
        })
        .collect();
    let trimmed = clean.trim();
    if trimmed.is_empty() {
        fallback.to_string()
    } else {
        trimmed.to_string()
    }
}

fn b64_decode(s: &str) -> Result<Vec<u8>, String> {
    // base64 padrão (com ou sem padding), sem deps externas.
    const ALPH: &[u8; 64] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
    let mut vals = [255u8; 256];
    for (i, &c) in ALPH.iter().enumerate() {
        vals[c as usize] = i as u8;
    }
    let bytes: Vec<u8> = s.bytes().filter(|&b| b != b'=' && !b.is_ascii_whitespace()).collect();
    let mut out = Vec::with_capacity(bytes.len() * 3 / 4);
    let mut i = 0;
    while i < bytes.len() {
        let mut n = [0u8; 4];
        let mut k = 0;
        for b in bytes.iter().skip(i).take(4) {
            let v = vals[*b as usize];
            if v == 255 {
                return Err("base64 inválido.".to_string());
            }
            n[k] = v;
            k += 1;
        }
        if k < 2 {
            break;
        }
        out.push((n[0] << 2) | (n[1] >> 4));
        if k > 2 {
            out.push(((n[1] & 0xF) << 4) | (n[2] >> 2));
        }
        if k > 3 {
            out.push(((n[2] & 0x3) << 6) | n[3]);
        }
        i += 4;
    }
    Ok(out)
}

fn b64_encode(bytes: &[u8]) -> String {
    const ALPH: &[u8; 64] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
    let mut out = String::with_capacity(bytes.len() * 4 / 3 + 4);
    for chunk in bytes.chunks(3) {
        let b = [chunk.first().copied().unwrap_or(0), chunk.get(1).copied().unwrap_or(0), chunk.get(2).copied().unwrap_or(0)];
        out.push(ALPH[(b[0] >> 2) as usize] as char);
        out.push(ALPH[(((b[0] & 3) << 4) | (b[1] >> 4)) as usize] as char);
        if chunk.len() > 1 {
            out.push(ALPH[(((b[1] & 0xF) << 2) | (b[2] >> 6)) as usize] as char);
        } else {
            out.push('=');
        }
        if chunk.len() > 2 {
            out.push(ALPH[(b[2] & 0x3F) as usize] as char);
        } else {
            out.push('=');
        }
    }
    out
}

// ---- banco: open/info/close ----

#[tauri::command(rename_all = "camelCase")]
pub fn db_open(state: tauri::State<DbState>, path: String) -> serde_json::Value {
    match Manager::open(&PathBuf::from(&path)) {
        Ok(mgr) => {
            let info = mgr.info().clone();
            *state.0.lock().unwrap() = Some(mgr);
            serde_json::json!({"opened": true, "info": info})
        }
        Err(error) => serde_json::json!({"opened": false, "error": error}),
    }
}

#[tauri::command(rename_all = "camelCase")]
pub fn db_open_dialog(state: tauri::State<DbState>) -> serde_json::Value {
    let picked = rfd::FileDialog::new()
        .set_title("Abrir base NeoGrid (SQLite)")
        .add_filter("Base NeoGrid", &["sqlite", "sqlite3", "db"])
        .add_filter("Todos os arquivos", &["*"])
        .pick_file();
    match picked {
        None => serde_json::json!({"opened": false, "cancelled": true}),
        Some(path) => db_open(state, path.to_string_lossy().to_string()),
    }
}

#[tauri::command(rename_all = "camelCase")]
pub fn db_info(state: tauri::State<DbState>) -> serde_json::Value {
    match state.0.lock().unwrap().as_ref() {
        Some(mgr) => serde_json::json!({"opened": true, "info": mgr.info()}),
        None => serde_json::json!({"opened": false}),
    }
}

#[tauri::command(rename_all = "camelCase")]
pub fn db_close(state: tauri::State<DbState>) -> serde_json::Value {
    *state.0.lock().unwrap() = None;
    serde_json::json!({"closed": true})
}

// ---- banco: consultas genéricas (database-client.js passa o channel) ----

#[tauri::command(rename_all = "camelCase")]
pub fn db_query(
    state: tauri::State<DbState>,
    channel: String,
    payload: serde_json::Value,
) -> serde_json::Value {
    let result: Result<serde_json::Value, String> = (|| {
        let guard = state.0.lock().map_err(|e| format!("lock: {e}"))?;
        let mgr = guard.as_ref().ok_or("Nenhum banco aberto.".to_string())?;
        let f64_field = |key: &str| payload.get(key).and_then(|v| v.as_f64()).unwrap_or(0.0);
        let i64_field = |key: &str, default: i64| {
            payload.get(key).and_then(|v| v.as_i64()).unwrap_or(default)
        };
        let str_field = |key: &str| payload.get(key).and_then(|v| v.as_str()).unwrap_or("");
        match channel.as_str() {
            "db:viewport" => Ok(serde_json::to_value(mgr.viewport(
                str_field("type"),
                f64_field("west"),
                f64_field("east"),
                f64_field("south"),
                f64_field("north"),
                i64_field("limit", 5000),
            )?).map_err(|e| e.to_string())?),
            "db:rows" => {
                let ids: Vec<i64> = payload.get("ids")
                    .and_then(|v| v.as_array())
                    .map(|a| a.iter().filter_map(|v| v.as_i64()).collect())
                    .unwrap_or_default();
                Ok(serde_json::to_value(mgr.rows(str_field("type"), &ids)?).map_err(|e| e.to_string())?)
            }
            "db:row" => Ok(serde_json::to_value(mgr.row(str_field("type"), i64_field("id", -1))?).map_err(|e| e.to_string())?),
            "db:bounds" => Ok(mgr.index_bounds(str_field("type"))?),
            "db:hotspots" => Ok(mgr.hotspots(str_field("type"), i64_field("limit", 1))?),
            "db:ids-in-bounds" => Ok(serde_json::to_value(mgr.ids_in_bounds(
                str_field("type"),
                f64_field("west"),
                f64_field("east"),
                f64_field("south"),
                f64_field("north"),
                i64_field("limit", 200000),
            )?).map_err(|e| e.to_string())?),
            "db:search" => Ok(serde_json::to_value(mgr.search(str_field("type"), str_field("term"), i64_field("limit", 30))?).map_err(|e| e.to_string())?),
            "db:find-by-id" => Ok(serde_json::to_value(mgr.find_by_id(str_field("type"), str_field("id"))?).map_err(|e| e.to_string())?),
            "db:page" => {
                let sort = payload.get("sort").and_then(|v| v.as_str());
                Ok(mgr.page(
                    str_field("type"),
                    i64_field("offset", 0),
                    i64_field("limit", 200),
                    str_field("search"),
                    sort,
                    i64_field("dir", 1),
                )?)
            }
            "db:distinct" => Ok(serde_json::to_value(mgr.distinct(str_field("type"), str_field("field"), i64_field("limit", 200))?).map_err(|e| e.to_string())?),
            "db:links" => Ok(mgr.links_for_pole(str_field("pole"))?),
            _ => Err(format!("Canal inválido: {channel}")),
        }
    })();
    match result {
        Ok(result) => serde_json::json!({"ok": true, "result": result}),
        Err(error) => serde_json::json!({"ok": false, "error": error}),
    }
}

// ---- build ----

fn progress_json(event: &ProgressEvent) -> serde_json::Value {
    match event {
        ProgressEvent::Log(message) => serde_json::json!({"type": "log", "message": message}),
        ProgressEvent::Phase { phase, layer, file, file_number, file_count } => serde_json::json!({
            "type": "phase", "phase": phase, "layer": layer, "file": file,
            "fileNumber": file_number, "fileCount": file_count,
        }),
        ProgressEvent::Progress { scan, layer, file, bytes, total_bytes } => serde_json::json!({
            "type": if *scan { "scan-progress" } else { "load-progress" },
            "layer": layer, "file": file, "bytes": bytes, "totalBytes": total_bytes,
        }),
    }
}

#[tauri::command(rename_all = "camelCase")]
pub async fn db_build_start(
    app: tauri::AppHandle,
    state: tauri::State<'_, BuildState>,
    payload: serde_json::Value,
) -> Result<serde_json::Value, String> {
    {
        let mut running = state.running.lock().map_err(|e| format!("lock: {e}"))?;
        if *running {
            return Ok(serde_json::json!({"started": false, "error": "Já existe uma conversão em andamento."}));
        }
        *running = true;
    }
    let get = |key: &str| payload.get(key);
        let source = get("source").and_then(|v| v.as_str()).unwrap_or("").to_string();
        let output = get("output").and_then(|v| v.as_str()).unwrap_or("").to_string();
        if source.is_empty() || output.is_empty() {
            *state.running.lock().map_err(|e| format!("lock: {e}"))? = false;
            return Ok(serde_json::json!({"started": false, "error": "Origem e destino são obrigatórios."}));
        }
        let manifesto_out = get("manifestoOut").and_then(|v| v.as_str()).map(|s| {
            if s.is_empty() { format!("{output}.manifesto.json") } else { s.to_string() }
        }).unwrap_or_else(|| format!("{output}.manifesto.json"));
        let manifesto_base = get("manifestoBase").and_then(|v| v.as_str()).filter(|s| !s.is_empty()).map(PathBuf::from);
        let reject_limit = get("rejectLimit").and_then(|v| v.as_f64()).filter(|v| *v > 0.0).unwrap_or(0.005);

        let cancel = Arc::new(AtomicBool::new(false));
        *state.cancel.lock().map_err(|e| format!("lock: {e}"))? = Some(cancel.clone());
        let app_emit = app.clone();
        let on_progress: neogrid_build::ProgressCallback = Arc::new(move |event| {
            let _ = app_emit.emit("db:build-progress", progress_json(&event));
        });
        let opts = Options {
            source: PathBuf::from(source),
            output: PathBuf::from(&output),
            manifesto_base,
            manifesto_out: Some(PathBuf::from(&manifesto_out)),
            reject_limit,
            cancel: Some(cancel),
            on_progress: Some(on_progress),
        };
        let result = tauri::async_runtime::spawn_blocking(move || build_database(&opts)).await
            .map_err(|e| format!("join: {e}"))?;

        *state.running.lock().map_err(|e| format!("lock: {e}"))? = false;
        *state.cancel.lock().map_err(|e| format!("lock: {e}"))? = None;

        match result {
            Ok(r) => {
                let done = serde_json::json!({
                    "type": "done",
                    "manifest": r.manifest,
                    "output": r.output.to_string_lossy(),
                });
                let _ = app.emit("db:build-progress", &done);
                Ok(serde_json::json!({
                    "started": true, "finished": true,
                    "manifest": done.get("manifest").cloned().unwrap_or(serde_json::Value::Null),
                    "output": r.output.to_string_lossy(),
                }))
            }
            Err(BuildError::Cancelled) => {
                let _ = app.emit("db:build-progress", serde_json::json!({"type": "cancelled"}));
                Ok(serde_json::json!({"started": true, "finished": false, "cancelled": true}))
            }
            Err(BuildError::Failed(error)) => {
                let _ = app.emit("db:build-progress", serde_json::json!({"type": "error", "error": error}));
                Ok(serde_json::json!({"started": true, "finished": false, "error": error}))
            }
        }
}

#[tauri::command(rename_all = "camelCase")]
pub fn db_build_cancel(state: tauri::State<BuildState>) -> serde_json::Value {
    let guard = state.cancel.lock().unwrap();
    let cancelling = guard.is_some();
    if let Some(cancel) = guard.as_ref() {
        cancel.store(true, Ordering::SeqCst);
    }
    serde_json::json!({"cancelling": cancelling})
}

#[tauri::command(rename_all = "camelCase")]
pub fn db_build_busy(state: tauri::State<BuildState>) -> serde_json::Value {
    serde_json::json!({"busy": *state.running.lock().unwrap()})
}

#[tauri::command(rename_all = "camelCase")]
pub fn db_pick_folder() -> serde_json::Value {
    match rfd::FileDialog::new().set_title("Pasta com os CSVs da extração").pick_folder() {
        None => serde_json::json!({"cancelled": true}),
        Some(path) => serde_json::json!({"cancelled": false, "path": path.to_string_lossy()}),
    }
}

#[tauri::command(rename_all = "camelCase")]
pub fn db_pick_output(suggested_name: Option<String>) -> serde_json::Value {
    let safe = sanitize_name(suggested_name.as_deref().unwrap_or("neogrid_base.sqlite"), "neogrid_base.sqlite");
    let mut documents = document_dir();
    documents.push(safe);
    match rfd::FileDialog::new()
        .set_title("Salvar base SQLite")
        .set_file_name(documents.to_string_lossy().as_ref())
        .add_filter("Base NeoGrid", &["sqlite"])
        .add_filter("Todos os arquivos", &["*"])
        .save_file()
    {
        None => serde_json::json!({"cancelled": true}),
        Some(path) => serde_json::json!({"cancelled": false, "path": path.to_string_lossy()}),
    }
}

// ---- projetos/snapshots ----

/// Migra o snapshot salvo pelo app Electron (`%APPDATA%\NeoGrid\projects`)
/// para o diretório do app Tauri (`%APPDATA%\br.com.neogrid.desktop\projects`)
/// na primeira execução. Nunca sobrescreve dados já existentes; silencioso.
pub fn migrate_legacy_projects(app: &tauri::AppHandle) {
    let Ok((_, target_autosave, target_meta)) = project_paths(app) else {
        return;
    };
    if target_autosave.exists() {
        return; // já tem dados próprios
    }
    let Some(appdata) = std::env::var_os("APPDATA") else {
        return;
    };
    let legacy_dir = PathBuf::from(appdata).join("NeoGrid").join("projects");
    let legacy_autosave = legacy_dir.join("autosave.neogrid");
    if !legacy_autosave.is_file() {
        return;
    }
    match std::fs::copy(&legacy_autosave, &target_autosave) {
        Ok(bytes) => {
            let legacy_meta = legacy_dir.join("autosave.meta.json");
            if legacy_meta.is_file() {
                let _ = std::fs::copy(&legacy_meta, &target_meta);
            }
            if std::env::var_os("NEOGRID_VERBOSE").is_some() {
                eprintln!("[neogrid] snapshot do Electron migrado ({bytes} bytes)");
            }
        }
        Err(error) => {
            if std::env::var_os("NEOGRID_VERBOSE").is_some() {
                eprintln!("[neogrid] falha ao migrar snapshot do Electron: {error}");
            }
        }
    }
}

fn project_paths(app: &tauri::AppHandle) -> Result<(PathBuf, PathBuf, PathBuf), String> {    let mut dir = app
        .path()
        .app_data_dir()
        .map_err(|e| format!("app-data: {e}"))?;
    dir.push("projects");
    std::fs::create_dir_all(&dir).map_err(|e| format!("mkdir: {e}"))?;
    let autosave = dir.join("autosave.neogrid");
    let meta = dir.join("autosave.meta.json");
    Ok((dir, autosave, meta))
}

fn file_stat(path: &PathBuf) -> serde_json::Value {
    match std::fs::metadata(path) {
        Ok(stat) => serde_json::json!({
            "exists": true,
            "size": stat.len(),
            "mtime": stat.modified().ok()
                .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
                .map(|d| d.as_millis() as u64)
                .unwrap_or(0),
        }),
        Err(_) => serde_json::json!({"exists": false, "size": 0, "mtime": 0}),
    }
}

fn read_meta(meta_path: &PathBuf) -> serde_json::Value {
    std::fs::read_to_string(meta_path)
        .ok()
        .and_then(|raw| serde_json::from_str(&raw).ok())
        .filter(|v: &serde_json::Value| v.is_object())
        .unwrap_or(serde_json::Value::Null)
}

#[tauri::command(rename_all = "camelCase")]
pub fn project_status(app: tauri::AppHandle) -> serde_json::Value {
    match project_paths(&app) {
        Ok((dir, autosave, meta_path)) => serde_json::json!({
            "supported": true,
            "dir": dir.to_string_lossy(),
            "autosavePath": autosave.to_string_lossy(),
            "file": file_stat(&autosave),
            "meta": read_meta(&meta_path),
        }),
        Err(error) => serde_json::json!({"supported": false, "error": error}),
    }
}

fn atomic_write(target: &PathBuf, bytes: &[u8]) -> Result<(), String> {
    if let Some(parent) = target.parent() {
        std::fs::create_dir_all(parent).map_err(|e| format!("mkdir: {e}"))?;
    }
    let tmp = target.with_extension(format!(
        "tmp-{}",
        std::process::id()
    ));
    std::fs::write(&tmp, bytes).map_err(|e| format!("write: {e}"))?;
    std::fs::rename(&tmp, target).map_err(|e| format!("rename: {e}"))?;
    Ok(())
}

#[tauri::command(rename_all = "camelCase")]
pub fn project_write_autosave(
    app: tauri::AppHandle,
    buffer_b64: String,
    meta: Option<serde_json::Value>,
) -> serde_json::Value {
    (|| -> Result<serde_json::Value, String> {
        let bytes = b64_decode(&buffer_b64)?;
        if bytes.is_empty() {
            return Err("Snapshot vazio.".to_string());
        }
        if bytes.len() > 1024 * 1024 * 1024 {
            return Err("Snapshot excede 1 GB.".to_string());
        }
        let (_, autosave, meta_path) = project_paths(&app)?;
        atomic_write(&autosave, &bytes)?;
        if let Some(meta) = meta.filter(|v| v.is_object()) {
            let mut obj = meta.as_object().cloned().unwrap_or_default();
            obj.insert("compressedBytes".to_string(), serde_json::json!(bytes.len()));
            std::fs::write(&meta_path, serde_json::to_string(&obj).unwrap_or_default())
                .map_err(|e| format!("meta: {e}"))?;
        }
        Ok(serde_json::json!({"saved": true, "path": autosave.to_string_lossy(), "bytes": bytes.len()}))
    })()
    .unwrap_or_else(|error| serde_json::json!({"saved": false, "error": error}))
}

#[tauri::command(rename_all = "camelCase")]
pub fn project_read_autosave(app: tauri::AppHandle) -> serde_json::Value {
    (|| -> Result<serde_json::Value, String> {
        let (_, autosave, meta_path) = project_paths(&app)?;
        let bytes = std::fs::read(&autosave).map_err(|_| "ENOENT".to_string())?;
        Ok(serde_json::json!({
            "found": true,
            "base64": b64_encode(&bytes),
            "meta": read_meta(&meta_path),
            "path": autosave.to_string_lossy(),
            "bytes": bytes.len(),
        }))
    })()
    .unwrap_or_else(|error| {
        if error == "ENOENT" {
            serde_json::json!({"found": false})
        } else {
            serde_json::json!({"found": false, "error": error})
        }
    })
}

#[tauri::command(rename_all = "camelCase")]
pub fn project_clear_autosave(app: tauri::AppHandle) -> serde_json::Value {
    (|| -> Result<(), String> {
        let (_, autosave, meta_path) = project_paths(&app)?;
        let _ = std::fs::remove_file(&autosave);
        let _ = std::fs::remove_file(&meta_path);
        Ok(())
    })()
    .map(|_| serde_json::json!({"cleared": true}))
    .unwrap_or_else(|error: String| serde_json::json!({"cleared": false, "error": error}))
}

#[tauri::command(rename_all = "camelCase")]
pub fn project_save_as(buffer_b64: String, suggested_name: Option<String>) -> serde_json::Value {
    let suggested = sanitize_name(suggested_name.as_deref().unwrap_or("neogrid_projeto.neogrid"), "neogrid_projeto.neogrid");
    let mut documents = document_dir();
    documents.push(suggested);
    let picked = rfd::FileDialog::new()
        .set_title("Salvar projeto NeoGrid")
        .set_file_name(documents.to_string_lossy().as_ref())
        .add_filter("Projeto NeoGrid", &["neogrid"])
        .add_filter("Todos os arquivos", &["*"])
        .save_file();
    match picked {
        None => serde_json::json!({"saved": false}),
        Some(path) => (|| -> Result<serde_json::Value, String> {
            let bytes = b64_decode(&buffer_b64)?;
            if bytes.is_empty() {
                return Err("Snapshot vazio.".to_string());
            }
            std::fs::write(&path, &bytes).map_err(|e| format!("write: {e}"))?;
            Ok(serde_json::json!({"saved": true, "path": path.to_string_lossy(), "bytes": bytes.len()}))
        })()
        .unwrap_or_else(|error| serde_json::json!({"saved": false, "error": error})),
    }
}

#[tauri::command(rename_all = "camelCase")]
pub fn project_open_file() -> serde_json::Value {
    let picked = rfd::FileDialog::new()
        .set_title("Abrir projeto NeoGrid")
        .add_filter("Projeto NeoGrid", &["neogrid"])
        .add_filter("Todos os arquivos", &["*"])
        .pick_file();
    match picked {
        None => serde_json::json!({"canceled": true}),
        Some(path) => (|| -> Result<serde_json::Value, String> {
            let bytes = std::fs::read(&path).map_err(|e| format!("read: {e}"))?;
            Ok(serde_json::json!({
                "canceled": false,
                "base64": b64_encode(&bytes),
                "path": path.to_string_lossy(),
                "name": path.file_name().map(|n| n.to_string_lossy().to_string()).unwrap_or_default(),
                "bytes": bytes.len(),
            }))
        })()
        .unwrap_or_else(|error| serde_json::json!({"canceled": false, "error": error})),
    }
}

// ---- arquivos genéricos / app / rede ----

fn document_dir() -> PathBuf {
    #[cfg(windows)]
    {
        std::env::var_os("USERPROFILE")
            .map(|home| PathBuf::from(home).join("Documents"))
            .unwrap_or_else(|| PathBuf::from("C:\\"))
    }
    #[cfg(not(windows))]
    {
        std::env::var_os("HOME").map(PathBuf::from).unwrap_or_else(|| PathBuf::from("/"))
    }
}

#[tauri::command(rename_all = "camelCase")]
pub fn file_save(
    title: Option<String>,
    default_name: Option<String>,
    filters: Option<Vec<(String, Vec<String>)>>,
    content: Option<String>,
) -> serde_json::Value {
    let suggested = sanitize_name(default_name.as_deref().unwrap_or("exportacao.txt"), "exportacao.txt");
    let mut documents = document_dir();
    documents.push(suggested);
    let mut dialog = rfd::FileDialog::new()
        .set_title(title.as_deref().unwrap_or("Salvar arquivo"))
        .set_file_name(documents.to_string_lossy().as_ref());
    if let Some(list) = filters.as_ref() {
        for (name, exts) in list {
            dialog = dialog.add_filter(name, &exts.iter().map(|s| s.as_str()).collect::<Vec<_>>());
        }
    } else {
        dialog = dialog.add_filter("Todos os arquivos", &["*"]);
    }
    match dialog.save_file() {
        None => serde_json::json!({"saved": false}),
        Some(path) => (|| -> Result<serde_json::Value, String> {
            std::fs::write(&path, content.as_deref().unwrap_or("")).map_err(|e| format!("write: {e}"))?;
            Ok(serde_json::json!({"saved": true, "path": path.to_string_lossy()}))
        })()
        .unwrap_or_else(|error| serde_json::json!({"saved": false, "error": error})),
    }
}

#[tauri::command(rename_all = "camelCase")]
pub fn file_reveal(path: Option<String>) -> bool {
    if let Some(p) = path {
        if !p.is_empty() {
            #[cfg(windows)]
            {
                let _ = std::process::Command::new("explorer")
                    .arg("/select,")
                    .arg(&p)
                    .spawn();
            }
            #[cfg(not(windows))]
            {
                let _ = std::process::Command::new("xdg-open")
                    .arg(std::path::Path::new(&p).parent().unwrap_or(std::path::Path::new(&p)))
                    .spawn();
            }
        }
    }
    true
}

#[tauri::command(rename_all = "camelCase")]
pub fn app_open_external(url: Option<String>) -> bool {
    match url {
        Some(u) if u.starts_with("http://") || u.starts_with("https://") => {
            #[cfg(windows)]
            {
                let _ = std::process::Command::new("cmd").args(["/C", "start", "", &u]).spawn();
            }
            #[cfg(not(windows))]
            {
                let _ = std::process::Command::new("xdg-open").arg(&u).spawn();
            }
            true
        }
        _ => false,
    }
}

#[tauri::command(rename_all = "camelCase")]
pub fn app_info(app: tauri::AppHandle) -> serde_json::Value {
    let package = app.package_info();
    serde_json::json!({
        "name": package.name,
        "version": package.version.to_string(),
        "platform": std::env::consts::OS,
        "arch": std::env::consts::ARCH,
        "userData": app.path().app_data_dir().ok().map(|p| p.to_string_lossy().to_string()).unwrap_or_default(),
        "packaged": true,
    })
}

#[tauri::command(rename_all = "camelCase")]
pub fn window_overlay_theme(window: tauri::Window, theme: Option<serde_json::Value>) -> bool {
    // No Windows o overlay usa as cores do sistema; aplica o estilo e ignora
    // as cores (desvio documentado do Electron, que tinge a barra).
    let _ = theme;
    window
        .set_title_bar_style(tauri::TitleBarStyle::Overlay)
        .is_ok()
}

/// Hosts permitidos para `net:fetch-text` (os mesmos que o app usa hoje).
fn host_allowed(host: &str) -> bool {
    const SUFFIXES: &[&str] = &[
        "arcgisonline.com",
        "openstreetmap.org",
        "basemaps.cartocdn.com",
        "komoot.io",
        "overpass-api.de",
        "overpass.kumi.systems",
        "overpass.osm.ch",
        "overpass.private.coffee",
        "maps.mail.ru",
    ];
    let host = host.to_lowercase();
    SUFFIXES.iter().any(|s| host == *s || host.ends_with(&format!(".{s}")))
}

#[tauri::command(rename_all = "camelCase")]
pub fn net_fetch_text(
    url: String,
    headers: Option<std::collections::HashMap<String, String>>,
    body: Option<String>,
    timeout_ms: Option<u64>,
) -> serde_json::Value {
    if !(url.starts_with("http://") || url.starts_with("https://")) {
        return serde_json::json!({"ok": false, "status": 0, "error": "URL inválida"});
    }
    let host = url
        .split("://")
        .nth(1)
        .unwrap_or("")
        .split(['/', '?', '#'])
        .next()
        .unwrap_or("")
        .split('@')
        .next_back()
        .unwrap_or("")
        .split(':')
        .next()
        .unwrap_or("");
    if !host_allowed(host) {
        return serde_json::json!({"ok": false, "status": 0, "error": "Host não permitido"});
    }
    let timeout = std::time::Duration::from_millis(timeout_ms.unwrap_or(30000).clamp(5000, 120000));
    (|| -> Result<serde_json::Value, String> {
        let config = ureq::Agent::config_builder()
            .timeout_global(Some(timeout))
            .http_status_as_error(false)
            .build();
        let agent = ureq::Agent::new_with_config(config);
        let resp = if let Some(text) = body.as_ref() {
            let mut req = agent.post(&url);
            req = req.header("User-Agent", "NeoGrid/2.0 (arruamento)");
            if let Some(map) = headers.as_ref() {
                for (k, v) in map {
                    if !k.eq_ignore_ascii_case("user-agent") {
                        req = req.header(k.as_str(), v.as_str());
                    }
                }
            }
            req.send(text.as_str()).map_err(|e| e.to_string())?
        } else {
            let mut req = agent.get(&url);
            req = req.header("User-Agent", "NeoGrid/2.0 (arruamento)");
            if let Some(map) = headers.as_ref() {
                for (k, v) in map {
                    if !k.eq_ignore_ascii_case("user-agent") {
                        req = req.header(k.as_str(), v.as_str());
                    }
                }
            }
            req.call().map_err(|e| e.to_string())?
        };
        let status = resp.status().as_u16() as i64;
        let text = resp.into_body().read_to_string().map_err(|e| e.to_string())?;
        Ok(serde_json::json!({"ok": (200..300).contains(&status), "status": status, "text": text}))
    })()
    .unwrap_or_else(|error| serde_json::json!({"ok": false, "status": 0, "error": error}))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn base64_roundtrip() {
        for len in [0, 1, 2, 3, 4, 5, 100, 1000] {
            let bytes: Vec<u8> = (0..len).map(|i| (i * 7 + 3) as u8).collect();
            let enc = b64_encode(&bytes);
            assert_eq!(b64_decode(&enc).unwrap(), bytes, "len={len}");
        }
        // sem padding / com whitespace (como o atob tolera)
        assert_eq!(b64_decode("YWI").unwrap(), b"ab");
        assert_eq!(b64_decode("YWI=\n").unwrap(), b"ab");
        assert!(b64_decode("!!!").is_err());
    }

    #[test]
    fn sanitize() {
        assert_eq!(sanitize_name("a/b\\c:d*e?f\"g<h>i|j", "fb"), "a-b-c-d-e-f-g-h-i-j");
        assert_eq!(sanitize_name("  ", "fb"), "fb");
        assert_eq!(sanitize_name("base.sqlite", "fb"), "base.sqlite");
    }

    #[test]
    fn allowlist() {
        for host in [
            "server.arcgisonline.com",
            "tile.openstreetmap.org",
            "a.basemaps.cartocdn.com",
            "photon.komoot.io",
            "nominatim.openstreetmap.org",
            "overpass-api.de",
            "overpass.kumi.systems",
            "maps.mail.ru",
        ] {
            assert!(host_allowed(host), "{host}");
        }
        for host in ["evil.com", "openstreetmap.org.evil.com", "", "komoot.io.evil.com"] {
            assert!(!host_allowed(host), "{host}");
        }
    }

    #[test]
    fn progress_shapes_match_js() {
        let log = progress_json(&ProgressEvent::Log("oi".to_string()));
        assert_eq!(log, serde_json::json!({"type": "log", "message": "oi"}));
        let phase = progress_json(&ProgressEvent::Phase {
            phase: "load",
            layer: "bt".to_string(),
            file: "a.csv".to_string(),
            file_number: 1,
            file_count: 2,
        });
        assert_eq!(
            phase,
            serde_json::json!({"type": "phase", "phase": "load", "layer": "bt", "file": "a.csv", "fileNumber": 1, "fileCount": 2})
        );
        let prog = progress_json(&ProgressEvent::Progress {
            scan: true,
            layer: "mt".to_string(),
            file: "b.csv".to_string(),
            bytes: 50,
            total_bytes: 100,
        });
        assert_eq!(
            prog,
            serde_json::json!({"type": "scan-progress", "layer": "mt", "file": "b.csv", "bytes": 50, "totalBytes": 100})
        );
    }
}
