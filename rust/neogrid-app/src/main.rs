//! Shell Tauri do NeoGrid: janela + commands finos sobre `neogrid-query` e
//! `neogrid-build`, com a mesma superficie do `preload.js` do Electron.
//!
//! - `--smoke <banco>`: exercita o core SEM abrir janela.
//! - `--window-smoke <marker>`: abre a janela, grava o marker e sai sozinho.

#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod commands;
mod serve;
mod updater;

use std::path::PathBuf;
use std::sync::Mutex;

use commands::{BuildState, DbState, PackState, WsState};

fn smoke(db: &str) -> Result<(), String> {
    let mgr = neogrid_query::Manager::open(&PathBuf::from(db))?;
    let info = mgr.info();
    let rows = info.get("rows").and_then(|v| v.as_u64()).unwrap_or(0);
    let viewport = mgr.viewport("poste", -35.0, -34.8, -8.2, -8.0, 10)?;
    println!("SMOKE rows={rows} viewport={}", viewport.len());
    println!("SMOKE build-lib={}", std::mem::size_of::<neogrid_build::Options>());
    Ok(())
}

fn main() {
    // Frontend servido em localhost:<porta efêmera> (mesma origem em dev e
    // produção; sem porta fixa, sem conflito com outras ferramentas). No dev,
    // com `NEOGRID_SRC_DIR`, serve do disco (edits aparecem no reload).
    let port = serve::spawn_server().expect("servidor do frontend");
    if std::env::var("NEOGRID_VERBOSE").is_ok() {
        eprintln!("[neogrid] frontend em http://localhost:{port}");
    }
    let args: Vec<String> = std::env::args().collect();
    if args.len() >= 3 && args[1] == "--smoke" {        match smoke(&args[2]) {
            Ok(()) => return,
            Err(e) => {
                eprintln!("SMOKE falhou: {e}");
                std::process::exit(1);
            }
        }
    }
    let window_smoke = args.len() >= 3 && args[1] == "--window-smoke";
    let marker = if window_smoke { args[2].clone() } else { String::new() };
    let mut builder = tauri::Builder::default();
    builder = builder
        .manage(DbState(Mutex::new(None)))
        .manage(BuildState::default())
        .manage(WsState::default())
        .manage(PackState::default())
        // Segunda instância apenas foca a janela existente (como o
        // `requestSingleInstanceLock` do Electron).
        .plugin(tauri_plugin_single_instance::init(|app, _argv, _cwd| {
            use tauri::Manager as _;
            if let Some(win) = app.get_webview_window("main") {
                let _ = win.unminimize();
                let _ = win.set_focus();
            }
        }))
        // Restaura posição/tamanho da janela entre execuções
        // (equivalente ao `window-state.json` do Electron).
        .plugin(tauri_plugin_window_state::Builder::default().build());
    builder = builder.invoke_handler(tauri::generate_handler![
        commands::db_open,
        commands::db_open_dialog,
        commands::db_info,
        commands::db_close,
        commands::db_query,
        commands::db_pick_folder,
        commands::db_pick_output,
        commands::db_build_start,
        commands::db_build_cancel,
        commands::db_build_busy,
        commands::project_status,
        commands::project_write_autosave,
        commands::project_read_autosave,
        commands::project_clear_autosave,
        commands::project_save_as,
        commands::project_open_file,
        commands::file_save,
        commands::file_reveal,
        commands::app_open_external,
        commands::app_info,
        commands::auth_request,
        commands::update_check,
        commands::update_install,
        commands::window_overlay_theme,
        commands::net_fetch_text,
        commands::db_area,
        commands::db_sql,
        commands::db_pick_zip,
        commands::ws_get,
        commands::ws_put,
        commands::ws_delete_prefix,
        commands::ws_stats,
        commands::pack_pick,
        commands::pack_write,
        commands::ruas_pack_status,
        commands::ruas_pack_tile,
        commands::ruas_pack_import,
        commands::ruas_pack_export,
        commands::ruas_pack_download,
        commands::ruas_pack_cancel,
    ]);
    // Janela criada em código (URL explícita no servidor embutido), em vez
    // de `tauri.conf.json > app > windows`: a URL inicial seria `file://`
    // quando o embed do Tauri não se aplica — aqui o destino é determinístico.
    builder = builder.setup(move |app| {
        // Primeira execução após o corte: traz o snapshot do app Electron.
        commands::migrate_legacy_projects(app.handle());
        tauri::WebviewWindowBuilder::new(
            app,
            "main",
            tauri::WebviewUrl::External(
                format!("http://localhost:{port}/")
                    .parse()
                    .expect("URL do frontend válida"),
            ),
        )
        .title("NeoGrid")
        .inner_size(1560.0, 960.0)
        .min_inner_size(1180.0, 720.0)
        .build()?;
        let handle = app.handle().clone();
        if window_smoke {
            std::thread::spawn(move || {
                std::thread::sleep(std::time::Duration::from_secs(8));
                let _ = std::fs::write(&marker, "window-alive");
                handle.exit(0);
            });
        }
        Ok(())
    });
    builder
        .run(tauri::generate_context!("tauri.conf.json"))
        .expect("tauri run");
}
