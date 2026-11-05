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

fn open_database(app: &tauri::AppHandle, path: &str) -> serde_json::Value {
    let state = app.state::<DbState>();
    match Manager::open(&PathBuf::from(path)) {
        Ok(mgr) => {
            let info = mgr.info().clone();
            *state.0.lock().unwrap() = Some(mgr);
            preparar_indice_busca(app.clone(), PathBuf::from(path));
            serde_json::json!({"opened": true, "info": info})
        }
        Err(error) => serde_json::json!({"opened": false, "error": error}),
    }
}

// O índice de busca fica em arquivo próprio nos dados do app: a base continua só leitura.
// É gerado na primeira abertura de cada base, em segundo plano, sem segurar o banco.
fn preparar_indice_busca(app: tauri::AppHandle, base: PathBuf) {
    std::thread::spawn(move || {
        let resultado = (|| -> Result<PathBuf, String> {
            let pasta = app.path().app_data_dir().map_err(|e| e.to_string())?.join("indice-busca");
            std::fs::create_dir_all(&pasta).map_err(|e| format!("criar pasta do índice: {e}"))?;
            let nome = neogrid_query::nome_indice_busca(&base)?;
            let arquivo = pasta.join(&nome);
            // Só o índice da base atual fica guardado.
            if let Ok(itens) = std::fs::read_dir(&pasta) {
                for item in itens.flatten() {
                    if item.file_name().to_string_lossy() != nome {
                        let _ = std::fs::remove_file(item.path());
                    }
                }
            }
            if !arquivo.exists() {
                neogrid_query::gerar_indice_busca(&base, &arquivo)?;
            }
            Ok(arquivo)
        })();
        let state = app.state::<DbState>();
        let Ok(guard) = state.0.lock() else { return };
        // A base pode ter sido trocada enquanto o índice era gerado.
        let Some(mgr) = guard.as_ref().filter(|m| m.path() == base.as_path()) else { return };
        match resultado.and_then(|arquivo| {
            mgr.usar_indice_busca(&arquivo).map_err(|erro| {
                let _ = std::fs::remove_file(&arquivo); // arquivo danificado: a próxima abertura refaz
                erro
            })
        }) {
            Ok(()) => {}
            Err(erro) => mgr.definir_estado_busca(neogrid_query::EstadoBusca::Erro(erro)),
        }
    });
}

#[tauri::command(rename_all = "camelCase")]
pub async fn db_open(app: tauri::AppHandle, path: String) -> serde_json::Value {
    fora_da_janela(
        move || open_database(&app, &path),
        |error| serde_json::json!({"opened": false, "error": error}),
    )
    .await
}

#[tauri::command(rename_all = "camelCase")]
pub fn db_open_dialog(app: tauri::AppHandle) -> serde_json::Value {
    let picked = rfd::FileDialog::new()
        .set_title("Abrir base NeoGrid (SQLite)")
        .add_filter("Base NeoGrid", &["sqlite", "sqlite3", "db"])
        .add_filter("Todos os arquivos", &["*"])
        .pick_file();
    match picked {
        None => serde_json::json!({"opened": false, "cancelled": true}),
        Some(path) => open_database(&app, &path.to_string_lossy()),
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

// Comandos síncronos do Tauri rodam na thread da janela: qualquer espera aqui vira
// "não está respondendo". Por isso banco e rede vão para `spawn_blocking`.
async fn fora_da_janela<T: Send + 'static>(
    trabalho: impl FnOnce() -> T + Send + 'static,
    falha: impl FnOnce(String) -> T,
) -> T {
    match tauri::async_runtime::spawn_blocking(trabalho).await {
        Ok(valor) => valor,
        Err(error) => falha(error.to_string()),
    }
}

#[tauri::command(rename_all = "camelCase")]
pub async fn db_query(
    app: tauri::AppHandle,
    channel: String,
    payload: serde_json::Value,
) -> serde_json::Value {
    fora_da_janela(
        move || db_query_sync(&app, &channel, &payload),
        |error| serde_json::json!({"ok": false, "error": error}),
    )
    .await
}

fn db_query_sync(app: &tauri::AppHandle, channel: &str, payload: &serde_json::Value) -> serde_json::Value {
    let state = app.state::<DbState>();
    let result: Result<serde_json::Value, String> = (|| {
        let guard = state.0.lock().map_err(|e| format!("lock: {e}"))?;
        let mgr = guard.as_ref().ok_or("Nenhum banco aberto.".to_string())?;
        let f64_field = |key: &str| payload.get(key).and_then(|v| v.as_f64()).unwrap_or(0.0);
        let i64_field = |key: &str, default: i64| {
            payload.get(key).and_then(|v| v.as_i64()).unwrap_or(default)
        };
        let str_field = |key: &str| payload.get(key).and_then(|v| v.as_str()).unwrap_or("");
        match channel {
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
            "db:search-fields" => mgr.search_fields(str_field("term"), i64_field("limit", 30)),
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
            "db:regions" => Ok(serde_json::json!({"all": mgr.regions(), "selected": mgr.selected_regions()})),
            "db:set-regions" => {
                let list: Vec<String> = payload.get("regions")
                    .and_then(|v| v.as_array())
                    .map(|a| a.iter().filter_map(|v| v.as_str().map(str::to_string)).collect())
                    .unwrap_or_default();
                mgr.set_regions(list);
                Ok(serde_json::json!(true))
            }
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

#[tauri::command(rename_all = "camelCase")]
pub fn db_pick_zip() -> serde_json::Value {
    match rfd::FileDialog::new()
        .set_title("Arquivo .zip com os CSVs da extração")
        .add_filter("Arquivo ZIP", &["zip"])
        .pick_file()
    {
        None => serde_json::json!({"cancelled": true}),
        Some(path) => serde_json::json!({"cancelled": false, "path": path.to_string_lossy()}),
    }
}

// ---- módulo Projeto: leitura em lote e SQL fora da thread principal ----

#[tauri::command(rename_all = "camelCase")]
pub async fn db_area(app: tauri::AppHandle, payload: serde_json::Value) -> serde_json::Value {
    let result = tauri::async_runtime::spawn_blocking(move || -> Result<serde_json::Value, String> {
        let state = app.state::<DbState>();
        let guard = state.0.lock().map_err(|e| format!("lock: {e}"))?;
        let mgr = guard.as_ref().ok_or("Nenhum banco aberto.".to_string())?;
        let num = |key: &str, default: f64| payload.get(key).and_then(|v| v.as_f64()).unwrap_or(default);
        let regions: Option<Vec<String>> = payload.get("regions").and_then(|v| v.as_array()).map(|a| {
            a.iter().filter_map(|v| v.as_str().map(str::to_string)).collect()
        });
        mgr.area(
            payload.get("type").and_then(|v| v.as_str()).unwrap_or(""),
            num("west", -180.0),
            num("east", 180.0),
            num("south", -90.0),
            num("north", 90.0),
            payload.get("limit").and_then(|v| v.as_i64()).unwrap_or(6_000_000),
            regions.as_deref(),
        )
    })
    .await;
    match result {
        Ok(Ok(value)) => serde_json::json!({"ok": true, "result": value}),
        Ok(Err(error)) => serde_json::json!({"ok": false, "error": error}),
        Err(error) => serde_json::json!({"ok": false, "error": error.to_string()}),
    }
}

#[tauri::command(rename_all = "camelCase")]
pub async fn db_sql(app: tauri::AppHandle, query: String, max: Option<usize>) -> serde_json::Value {
    let context = {
        let state = app.state::<DbState>();
        let guard = match state.0.lock() {
            Ok(guard) => guard,
            Err(error) => return serde_json::json!({"ok": false, "error": format!("lock: {error}")}),
        };
        match guard.as_ref() {
            Some(mgr) => mgr.sql_context(),
            None => return serde_json::json!({"ok": false, "error": "Nenhum banco aberto."}),
        }
    };
    let result = tauri::async_runtime::spawn_blocking(move || context.run(&query, max.unwrap_or(5000))).await;
    match result {
        Ok(Ok(value)) => serde_json::json!({"ok": true, "result": value}),
        Ok(Err(error)) => serde_json::json!({"ok": false, "error": error}),
        Err(error) => serde_json::json!({"ok": false, "error": error.to_string()}),
    }
}

// ---- banco de trabalho: configuração do projeto e cache de ruas ----
// Fica separado da base mensal: regenerar a base não apaga o trabalho do usuário.

#[derive(Default)]
pub struct WsState(pub Mutex<Option<rusqlite::Connection>>);

fn with_workspace<T>(
    app: &tauri::AppHandle,
    state: &WsState,
    action: impl FnOnce(&rusqlite::Connection) -> rusqlite::Result<T>,
) -> Result<T, String> {
    let mut guard = state.0.lock().map_err(|e| format!("lock: {e}"))?;
    if guard.is_none() {
        let dir = app.path().app_data_dir().map_err(|e| e.to_string())?;
        std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
        let conn = rusqlite::Connection::open(dir.join("workspace.sqlite")).map_err(|e| e.to_string())?;
        conn.execute_batch(
            "PRAGMA journal_mode = WAL; PRAGMA synchronous = NORMAL;
             CREATE TABLE IF NOT EXISTS kv (k TEXT PRIMARY KEY, v TEXT NOT NULL);",
        )
        .map_err(|e| e.to_string())?;
        *guard = Some(conn);
    }
    action(guard.as_ref().expect("conexão aberta acima")).map_err(|e| e.to_string())
}

#[tauri::command(rename_all = "camelCase")]
pub async fn ws_get(app: tauri::AppHandle, key: String) -> Result<Option<String>, String> {
    use rusqlite::OptionalExtension as _;
    fora_da_janela(
        move || {
            with_workspace(&app, &app.state::<WsState>(), |conn| {
                conn.query_row("SELECT v FROM kv WHERE k = ?", [&key], |r| r.get(0)).optional()
            })
        },
        Err,
    )
    .await
}

#[tauri::command(rename_all = "camelCase")]
pub async fn ws_put(app: tauri::AppHandle, key: String, value: String) -> Result<bool, String> {
    fora_da_janela(
        move || {
            with_workspace(&app, &app.state::<WsState>(), |conn| {
                conn.execute("INSERT OR REPLACE INTO kv (k, v) VALUES (?, ?)", [&key, &value]).map(|_| true)
            })
        },
        Err,
    )
    .await
}

#[tauri::command(rename_all = "camelCase")]
pub async fn ws_delete_prefix(app: tauri::AppHandle, prefix: String) -> Result<usize, String> {
    fora_da_janela(
        move || {
            with_workspace(&app, &app.state::<WsState>(), |conn| {
                conn.execute("DELETE FROM kv WHERE substr(k, 1, length(?1)) = ?1", [&prefix])
            })
        },
        Err,
    )
    .await
}

#[tauri::command(rename_all = "camelCase")]
pub async fn ws_stats(app: tauri::AppHandle, prefix: String) -> Result<serde_json::Value, String> {
    fora_da_janela(
        move || {
            with_workspace(&app, &app.state::<WsState>(), |conn| {
                conn.query_row(
                    "SELECT count(*), coalesce(sum(length(v)), 0) FROM kv WHERE substr(k, 1, length(?1)) = ?1",
                    [&prefix],
                    |r| Ok(serde_json::json!({"n": r.get::<_, i64>(0)?, "bytes": r.get::<_, i64>(1)?})),
                )
            })
        },
        Err,
    )
    .await
}

// ---- pacote de ruas offline ----

const RUAS_FONTE: &str = "https://download.geofabrik.de/south-america/brazil/nordeste-latest.osm.pbf";
const RUAS_ARQUIVO: &str = "ruas.neogrid-ruas";

#[derive(Default)]
pub struct PackState {
    conn: Mutex<Option<rusqlite::Connection>>,
    busy: AtomicBool,
    cancel: Mutex<Option<Arc<AtomicBool>>>,
}

fn pack_path(app: &tauri::AppHandle) -> Result<PathBuf, String> {
    let dir = app.path().app_data_dir().map_err(|e| e.to_string())?;
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    Ok(dir.join(RUAS_ARQUIVO))
}

fn pack_open(path: &std::path::Path) -> Result<rusqlite::Connection, String> {
    rusqlite::Connection::open_with_flags(path, rusqlite::OpenFlags::SQLITE_OPEN_READ_ONLY)
        .map_err(|e| format!("abrir pacote: {e}"))
}

fn with_pack<T>(
    app: &tauri::AppHandle,
    action: impl FnOnce(&rusqlite::Connection) -> Result<T, String>,
) -> Result<Option<T>, String> {
    let state = app.state::<PackState>();
    let mut guard = state.conn.lock().map_err(|e| format!("lock: {e}"))?;
    if guard.is_none() {
        let path = pack_path(app)?;
        if !path.exists() {
            return Ok(None);
        }
        *guard = Some(pack_open(&path)?);
    }
    action(guard.as_ref().expect("conexão aberta acima")).map(Some)
}

fn pack_status_value(app: &tauri::AppHandle) -> Result<serde_json::Value, String> {
    let bytes = pack_path(app).ok().and_then(|p| std::fs::metadata(p).ok()).map(|m| m.len()).unwrap_or(0);
    let busy = app.state::<PackState>().busy.load(Ordering::Relaxed);
    Ok(match with_pack(app, neogrid_build::ruas::read_info)? {
        Some(info) => serde_json::json!({"instalado": true, "info": info, "bytes": bytes, "busy": busy}),
        None => serde_json::json!({"instalado": false, "busy": busy}),
    })
}

#[tauri::command(rename_all = "camelCase")]
pub async fn ruas_pack_status(app: tauri::AppHandle) -> Result<serde_json::Value, String> {
    fora_da_janela(move || pack_status_value(&app), Err).await
}

#[tauri::command(rename_all = "camelCase")]
pub async fn ruas_pack_tile(app: tauri::AppHandle, key: String) -> Result<Option<String>, String> {
    fora_da_janela(
        move || with_pack(&app, |conn| neogrid_build::ruas::read_tile(conn, &key)).map(Option::flatten),
        Err,
    )
    .await
}

/// Substitui o pacote em uso por um arquivo já validado.
fn pack_install(app: &tauri::AppHandle, source: &std::path::Path, mover: bool) -> Result<(), String> {
    let target = pack_path(app)?;
    let state = app.state::<PackState>();
    let mut guard = state.conn.lock().map_err(|e| format!("lock: {e}"))?;
    *guard = None;
    let resultado = if mover {
        std::fs::rename(source, &target).map_err(|e| format!("instalar pacote: {e}"))
    } else {
        let temp = target.with_extension("copia");
        std::fs::copy(source, &temp)
            .and_then(|_| std::fs::rename(&temp, &target))
            .map_err(|e| {
                let _ = std::fs::remove_file(&temp);
                format!("copiar pacote: {e}")
            })
    };
    resultado
}

#[tauri::command(rename_all = "camelCase")]
pub async fn ruas_pack_import(app: tauri::AppHandle) -> Result<serde_json::Value, String> {
    let Some(path) = rfd::AsyncFileDialog::new()
        .set_title("Importar pacote de ruas ou extrato do OpenStreetMap")
        .add_filter("Pacote de ruas ou extrato OSM", &["neogrid-ruas", "pbf"])
        .pick_file()
        .await
    else {
        return Ok(serde_json::json!({"cancelled": true}));
    };
    let source = path.path().to_path_buf();
    let is_pbf = source.extension().map(|e| e.eq_ignore_ascii_case("pbf")).unwrap_or(false);
    fora_da_janela(
        move || {
            if is_pbf {
                build_from_pbf(&app, &source, source.file_name().unwrap_or_default().to_string_lossy().as_ref())?;
            } else {
                neogrid_build::ruas::read_info(&pack_open(&source)?)?;
                pack_install(&app, &source, false)?;
            }
            pack_status_value(&app)
        },
        Err,
    )
    .await
}

#[tauri::command(rename_all = "camelCase")]
pub async fn ruas_pack_export(app: tauri::AppHandle) -> Result<serde_json::Value, String> {
    let source = pack_path(&app)?;
    if !source.exists() {
        return Err("Ainda não há pacote de ruas neste computador.".to_string());
    }
    let Some(target) = rfd::AsyncFileDialog::new()
        .set_title("Exportar pacote de ruas")
        .set_directory(document_dir())
        .set_file_name("ruas_pernambuco.neogrid-ruas")
        .add_filter("Pacote de ruas", &["neogrid-ruas"])
        .save_file()
        .await
    else {
        return Ok(serde_json::json!({"cancelled": true}));
    };
    let destino = target.path().to_path_buf();
    fora_da_janela(
        move || {
            std::fs::copy(&source, &destino).map_err(|e| format!("copiar pacote: {e}"))?;
            Ok(serde_json::json!({"saved": true, "path": destino.to_string_lossy()}))
        },
        Err,
    )
    .await
}

fn pack_emit(app: &tauri::AppHandle, etapa: &str, fracao: Option<f64>) {
    let _ = app.emit("ruas:progress", serde_json::json!({"etapa": etapa, "fracao": fracao}));
}

fn build_from_pbf(app: &tauri::AppHandle, pbf: &std::path::Path, origem: &str) -> Result<(), String> {
    let state = app.state::<PackState>();
    if state.busy.swap(true, Ordering::SeqCst) {
        return Err("O pacote de ruas já está sendo gerado.".to_string());
    }
    let cancel = Arc::new(AtomicBool::new(false));
    if let Ok(mut slot) = state.cancel.lock() {
        *slot = Some(cancel.clone());
    }
    let resultado = (|| -> Result<(), String> {
        let target = pack_path(app)?;
        let novo = target.with_extension("novo");
        let emissor = app.clone();
        let on_event: neogrid_build::ruas::PackCallback = Arc::new(move |e| match e {
            neogrid_build::ruas::PackEvent::Etapa(nome, f) => pack_emit(&emissor, nome, f),
            neogrid_build::ruas::PackEvent::Log(texto) => pack_emit(&emissor, &texto, None),
        });
        let data = data_de_hoje();
        neogrid_build::ruas::build_pack(pbf, &novo, origem, &data, Some(cancel), Some(on_event))?;
        pack_install(app, &novo, true)
    })();
    state.busy.store(false, Ordering::SeqCst);
    resultado
}

fn data_de_hoje() -> String {
    let dias = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs() / 86_400)
        .unwrap_or(0) as i64;
    // Algoritmo de Howard Hinnant: dias desde 1970 -> data civil.
    let z = dias + 719_468;
    let era = z.div_euclid(146_097);
    let doe = z.rem_euclid(146_097);
    let yoe = (doe - doe / 1460 + doe / 36_524 - doe / 146_096) / 365;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = doy - (153 * mp + 2) / 5 + 1;
    let m = if mp < 10 { mp + 3 } else { mp - 9 };
    let y = yoe + era * 400 + i64::from(m <= 2);
    format!("{y:04}-{m:02}-{d:02}")
}

#[tauri::command(rename_all = "camelCase")]
pub async fn ruas_pack_download(app: tauri::AppHandle) -> Result<serde_json::Value, String> {
    fora_da_janela(
        move || {
            let dir = app.path().app_data_dir().map_err(|e| e.to_string())?;
            std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
            let pbf = dir.join("extrato.osm.pbf");
            let cancel = Arc::new(AtomicBool::new(false));
            if let Ok(mut slot) = app.state::<PackState>().cancel.lock() {
                *slot = Some(cancel.clone());
            }
            let baixado = (|| -> Result<(), String> {
                pack_emit(&app, "Conectando ao servidor do OpenStreetMap", None);
                let resp = http_agent(std::time::Duration::from_secs(3600))
                    .get(RUAS_FONTE)
                    .header("User-Agent", "NeoGrid/3.0 (pacote de ruas)")
                    .call()
                    .map_err(|e| format!("baixar extrato: {e}"))?;
                if !resp.status().is_success() {
                    return Err(format!("baixar extrato: HTTP {}", resp.status().as_u16()));
                }
                let total: u64 = resp
                    .headers()
                    .get("content-length")
                    .and_then(|v| v.to_str().ok())
                    .and_then(|v| v.parse().ok())
                    .unwrap_or(0);
                let mut leitor = resp.into_body().into_reader();
                let mut saida = std::fs::File::create(&pbf).map_err(|e| format!("criar extrato: {e}"))?;
                let mut buf = vec![0u8; 1 << 20];
                let mut feitos: u64 = 0;
                loop {
                    if cancel.load(Ordering::Relaxed) {
                        return Err("Download cancelado.".to_string());
                    }
                    let n = std::io::Read::read(&mut leitor, &mut buf).map_err(|e| format!("baixar extrato: {e}"))?;
                    if n == 0 {
                        break;
                    }
                    std::io::Write::write_all(&mut saida, &buf[..n]).map_err(|e| format!("gravar extrato: {e}"))?;
                    feitos += n as u64;
                    let texto = format!("Baixando o extrato: {} de {} MB", feitos / 1_048_576, total / 1_048_576);
                    pack_emit(&app, &texto, if total > 0 { Some(feitos as f64 / total as f64) } else { None });
                }
                Ok(())
            })();
            let gerado = baixado.and_then(|()| build_from_pbf(&app, &pbf, "Geofabrik: nordeste-latest.osm.pbf"));
            let _ = std::fs::remove_file(&pbf);
            gerado?;
            pack_status_value(&app)
        },
        Err,
    )
    .await
}

#[tauri::command(rename_all = "camelCase")]
pub fn ruas_pack_cancel(state: tauri::State<PackState>) -> bool {
    if let Ok(slot) = state.cancel.lock() {
        if let Some(flag) = slot.as_ref() {
            flag.store(true, Ordering::Relaxed);
            return true;
        }
    }
    false
}

/// Proxy das variáveis de ambiente ou, na falta delas, o configurado no Windows.
fn proxy_do_sistema() -> Option<ureq::Proxy> {
    static PROXY: std::sync::OnceLock<Option<String>> = std::sync::OnceLock::new();
    let url = PROXY.get_or_init(|| {
        for nome in ["HTTPS_PROXY", "https_proxy", "HTTP_PROXY", "http_proxy", "ALL_PROXY"] {
            if let Ok(valor) = std::env::var(nome) {
                if !valor.trim().is_empty() {
                    return Some(valor);
                }
            }
        }
        proxy_do_registro()
    });
    url.as_deref().and_then(|u| ureq::Proxy::new(u).ok())
}

#[cfg(windows)]
fn proxy_do_registro() -> Option<String> {
    use std::os::windows::process::CommandExt as _;
    const SEM_JANELA: u32 = 0x0800_0000;
    let chave = r"HKCU\Software\Microsoft\Windows\CurrentVersion\Internet Settings";
    let consulta = |nome: &str| -> Option<String> {
        let saida = std::process::Command::new("reg")
            .args(["query", chave, "/v", nome])
            .creation_flags(SEM_JANELA)
            .output()
            .ok()?;
        let texto = String::from_utf8_lossy(&saida.stdout).to_string();
        texto.lines().find(|l| l.contains(nome))?.split_whitespace().last().map(str::to_string)
    };
    if consulta("ProxyEnable")?.trim_start_matches("0x") == "0" {
        return None;
    }
    let servidor = consulta("ProxyServer")?;
    // Pode vir como "http=host:porta;https=host:porta".
    let escolhido = servidor
        .split(';')
        .find_map(|p| p.strip_prefix("https="))
        .or_else(|| servidor.split(';').find_map(|p| p.strip_prefix("http=")))
        .unwrap_or(&servidor);
    Some(format!("http://{escolhido}"))
}

#[cfg(not(windows))]
fn proxy_do_registro() -> Option<String> {
    None
}

fn http_agent(timeout: std::time::Duration) -> ureq::Agent {
    let config = ureq::Agent::config_builder()
        .timeout_global(Some(timeout))
        .http_status_as_error(false)
        .proxy(proxy_do_sistema())
        .build();
    ureq::Agent::new_with_config(config)
}

// ---- Pacote de Projeto: grava vários arquivos em uma pasta ou em um .zip ----

/// Caminho relativo seguro: sem `..`, sem raiz e com nomes válidos no Windows.
fn safe_relative(name: &str) -> Option<PathBuf> {
    let mut out = PathBuf::new();
    for part in name.split(['/', '\\']) {
        if part.is_empty() || part == "." || part == ".." {
            return None;
        }
        out.push(sanitize_name(part, "arquivo"));
    }
    if out.as_os_str().is_empty() { None } else { Some(out) }
}

fn pack_file_bytes(file: &serde_json::Value) -> Result<(String, Vec<u8>), String> {
    let name = file.get("name").and_then(|v| v.as_str()).unwrap_or("");
    let bytes = if let Some(text) = file.get("text").and_then(|v| v.as_str()) {
        text.as_bytes().to_vec()
    } else {
        b64_decode(file.get("base64").and_then(|v| v.as_str()).unwrap_or(""))?
    };
    Ok((name.to_string(), bytes))
}

#[tauri::command(rename_all = "camelCase")]
pub fn pack_pick(mode: String, suggested_name: Option<String>) -> serde_json::Value {
    let name = sanitize_name(suggested_name.as_deref().unwrap_or("projeto"), "projeto");
    let picked = if mode == "pasta" {
        rfd::FileDialog::new()
            .set_title("Pasta onde criar o pacote do projeto")
            .set_directory(document_dir())
            .pick_folder()
            .map(|p| p.join(&name))
    } else {
        rfd::FileDialog::new()
            .set_title("Salvar pacote do projeto")
            .set_directory(document_dir())
            .set_file_name(format!("{name}.zip"))
            .add_filter("Arquivo ZIP", &["zip"])
            .save_file()
    };
    match picked {
        None => serde_json::json!({"cancelled": true}),
        Some(path) => serde_json::json!({"cancelled": false, "path": path.to_string_lossy()}),
    }
}

/// Grava em arquivo temporário e renomeia: uma falha nunca deixa pacote pela metade.
#[tauri::command(rename_all = "camelCase")]
pub async fn pack_write(path: String, mode: String, files: Vec<serde_json::Value>) -> serde_json::Value {
    let target = PathBuf::from(&path);
    let result = tauri::async_runtime::spawn_blocking(move || -> Result<(), String> {
        if mode == "pasta" {
            for file in &files {
                let (name, bytes) = pack_file_bytes(file)?;
                let rel = safe_relative(&name).ok_or_else(|| format!("Nome inválido: {name}"))?;
                let dest = target.join(rel);
                if let Some(parent) = dest.parent() {
                    std::fs::create_dir_all(parent).map_err(|e| format!("criar pasta: {e}"))?;
                }
                std::fs::write(&dest, bytes).map_err(|e| format!("gravar {name}: {e}"))?;
            }
            return Ok(());
        }
        let temp = target.with_extension("zip.tmp");
        let written = (|| -> Result<(), String> {
            let out = std::fs::File::create(&temp).map_err(|e| format!("criar arquivo: {e}"))?;
            let mut archive = zip::ZipWriter::new(out);
            let options = zip::write::SimpleFileOptions::default()
                .compression_method(zip::CompressionMethod::Deflated)
                .large_file(true);
            for file in &files {
                let (name, bytes) = pack_file_bytes(file)?;
                let rel = safe_relative(&name).ok_or_else(|| format!("Nome inválido: {name}"))?;
                archive
                    .start_file(rel.to_string_lossy().replace('\\', "/"), options)
                    .map_err(|e| e.to_string())?;
                std::io::Write::write_all(&mut archive, &bytes).map_err(|e| e.to_string())?;
            }
            archive.finish().map_err(|e| e.to_string())?;
            Ok(())
        })();
        if let Err(error) = written {
            let _ = std::fs::remove_file(&temp);
            return Err(error);
        }
        std::fs::rename(&temp, &target).map_err(|e| {
            let _ = std::fs::remove_file(&temp);
            format!("finalizar arquivo: {e}")
        })
    })
    .await;
    match result {
        Ok(Ok(())) => serde_json::json!({"saved": true, "path": path}),
        Ok(Err(error)) => serde_json::json!({"saved": false, "error": error}),
        Err(error) => serde_json::json!({"saved": false, "error": error.to_string()}),
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
pub async fn net_fetch_text(
    url: String,
    headers: Option<std::collections::HashMap<String, String>>,
    body: Option<String>,
    timeout_ms: Option<u64>,
) -> serde_json::Value {
    fora_da_janela(
        move || net_fetch_sync(url, headers, body, timeout_ms),
        |error| serde_json::json!({"ok": false, "status": 0, "error": error}),
    )
    .await
}

fn net_fetch_sync(
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
        let agent = http_agent(timeout);
        let resp = if let Some(text) = body.as_ref() {
            let mut req = agent.post(&url);
            req = req.header("User-Agent", "NeoGrid/3.0 (arruamento)");
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
            req = req.header("User-Agent", "NeoGrid/3.0 (arruamento)");
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
