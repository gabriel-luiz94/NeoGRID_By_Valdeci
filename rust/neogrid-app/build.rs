//! Build script: codegen do Tauri + manifesto ACL com TODOS os commands do app.
//!
//! Sem `AppManifest::commands`, o runtime nega todo `invoke` com
//! "<cmd> not allowed. Plugin not found" (só passa em dev, onde o ACL é
//! relaxado). Manter esta lista IGUAL ao `generate_handler!` de `main.rs`
//! (`parity/contract-check.js` audita isso).

fn main() {
    tauri_build::try_build(
        tauri_build::Attributes::new().app_manifest(tauri_build::AppManifest::new().commands(&[
            "db_open",
            "db_open_dialog",
            "db_info",
            "db_close",
            "db_query",
            "db_pick_folder",
            "db_pick_output",
            "db_build_start",
            "db_build_cancel",
            "db_build_busy",
            "project_status",
            "project_write_autosave",
            "project_read_autosave",
            "project_clear_autosave",
            "project_save_as",
            "project_open_file",
            "file_save",
            "file_reveal",
            "app_open_external",
            "app_info",
            "window_overlay_theme",
            "net_fetch_text",
            "db_area",
            "db_sql",
            "db_pick_zip",
            "ws_get",
            "ws_put",
            "ws_delete_prefix",
            "ws_stats",
            "pack_pick",
            "pack_write",
            "ruas_pack_status",
            "ruas_pack_tile",
            "ruas_pack_import",
            "ruas_pack_export",
            "ruas_pack_download",
            "ruas_pack_cancel",
        ])),
    )
    .expect("tauri build");
}
