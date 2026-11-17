//! Atualização automática pelo GitHub Releases.
//!
//! O app consulta a release mais recente do repositório público, compara a
//! versão com a instalada e, quando há uma nova, baixa o instalador NSIS
//! (`*setup.exe`) anexado à release e o executa em modo silencioso (`/S`).
//!
//! Não usamos `tauri-plugin-updater` de propósito: o instalador já é o mesmo
//! artefato distribuído aos usuários, e o repositório é público — não há
//! chave de assinatura para manter. A confiança vem do HTTPS somado ao
//! repositório fixo no código (o usuário não escolhe a origem).
//!
//! Este módulo contém só a lógica; os commands Tauri ficam em `commands.rs`
//! para manter o contrato (`parity/contract-check.js`) em um só lugar.

use std::cmp::Ordering;
use std::io::{Read as _, Write as _};
use std::path::{Path, PathBuf};
use std::time::{Duration, Instant};

use tauri::Emitter as _;

use crate::commands::http_agent;

/// Repositório de onde saem as atualizações (público, fixo).
const API_LATEST: &str =
    "https://api.github.com/repos/gabriel-luiz94/NeoGRID_By_Valdeci/releases/latest";
const WEB_LATEST: &str =
    "https://github.com/gabriel-luiz94/NeoGRID_By_Valdeci/releases/latest";
const USER_AGENT: &str = "NeoGrid-Updater/3 (+https://github.com/gabriel-luiz94/NeoGRID_By_Valdeci)";
/// Instalador menor que isso é resposta de erro disfarçada de arquivo.
const MIN_INSTALLER_BYTES: u64 = 1 << 20;

#[derive(Debug, Clone)]
struct Release {
    version: String,
    tag: String,
    name: String,
    notes: String,
    published_at: String,
    asset_name: String,
    asset_url: String,
    asset_size: u64,
}

/// Uma consulta HTTP contra a API do GitHub (JSON).
fn api_get(url: &str) -> Result<(u16, String), String> {
    let agent = http_agent(Duration::from_secs(25));
    let resp = agent
        .get(url)
        .header("User-Agent", USER_AGENT)
        .header("Accept", "application/vnd.github+json")
        .header("X-GitHub-Api-Version", "2022-11-28")
        .call()
        .map_err(|e| format!("conexão com o GitHub: {e}"))?;
    let status = resp.status().as_u16();
    let body = resp
        .into_body()
        .read_to_string()
        .map_err(|e| format!("resposta do GitHub: {e}"))?;
    Ok((status, body))
}

/// Escolhe o instalador anexado à release, preferindo o `setup.exe` do NSIS.
fn pick_asset(assets: &[serde_json::Value]) -> Option<(String, String, u64)> {
    let mut best: Option<(u8, String, String, u64)> = None;
    for asset in assets {
        let name = asset.get("name").and_then(|v| v.as_str()).unwrap_or("");
        let url = asset
            .get("browser_download_url")
            .and_then(|v| v.as_str())
            .unwrap_or("");
        if name.is_empty() || url.is_empty() {
            continue;
        }
        let lower = name.to_ascii_lowercase();
        let score = if lower.ends_with("-setup.exe") {
            4
        } else if lower.contains("setup") && lower.ends_with(".exe") {
            3
        } else if lower.ends_with(".exe") && !lower.contains("uninstall") {
            2
        } else if lower.ends_with(".msi") {
            1
        } else {
            continue;
        };
        if best.as_ref().map(|b| score > b.0).unwrap_or(true) {
            best = Some((
                score,
                name.to_string(),
                url.to_string(),
                asset.get("size").and_then(|v| v.as_u64()).unwrap_or(0),
            ));
        }
    }
    best.map(|(_, name, url, size)| (name, url, size))
}

fn parse_release(body: &str) -> Result<Release, String> {
    let json: serde_json::Value =
        serde_json::from_str(body).map_err(|e| format!("resposta inválida do GitHub: {e}"))?;
    let tag = json
        .get("tag_name")
        .and_then(|v| v.as_str())
        .unwrap_or("")
        .trim()
        .to_string();
    if tag.is_empty() {
        return Err("a release mais recente não tem tag de versão.".to_string());
    }
    let assets = json
        .get("assets")
        .and_then(|v| v.as_array())
        .cloned()
        .unwrap_or_default();
    let (asset_name, asset_url, asset_size) =
        pick_asset(&assets).ok_or("a release não tem instalador (.exe) anexado.")?;
    Ok(Release {
        version: tag.trim_start_matches(['v', 'V']).to_string(),
        tag,
        name: json
            .get("name")
            .and_then(|v| v.as_str())
            .unwrap_or("")
            .to_string(),
        notes: json
            .get("body")
            .and_then(|v| v.as_str())
            .unwrap_or("")
            .to_string(),
        published_at: json
            .get("published_at")
            .and_then(|v| v.as_str())
            .unwrap_or("")
            .to_string(),
        asset_name,
        asset_url,
        asset_size,
    })
}

/// Compara versões `x.y.z[-pre]`. `1.0.0` > `1.0.0-beta`.
fn version_cmp(left: &str, right: &str) -> Ordering {
    let (a, apre) = split_version(left);
    let (b, bpre) = split_version(right);
    match (a, b) {
        (Some(a), Some(b)) => match a.cmp(&b) {
            Ordering::Equal => match (apre, bpre) {
                (None, None) => Ordering::Equal,
                (None, Some(_)) => Ordering::Greater,
                (Some(_), None) => Ordering::Less,
                (Some(x), Some(y)) => x.cmp(&y),
            },
            other => other,
        },
        _ => left
            .trim_start_matches(['v', 'V'])
            .cmp(right.trim_start_matches(['v', 'V'])),
    }
}

fn split_version(value: &str) -> (Option<(u64, u64, u64)>, Option<String>) {
    let raw = value.trim();
    let raw = raw.split('+').next().unwrap_or(raw);
    let (core, pre) = match raw.split_once('-') {
        Some((core, pre)) => (core, Some(pre.to_string())),
        None => (raw, None),
    };
    let core = core.trim_start_matches(['v', 'V']);
    let mut parts = core.split('.');
    let major = parts.next().and_then(|p| p.parse::<u64>().ok());
    let minor = parts
        .next()
        .and_then(|p| p.parse::<u64>().ok())
        .unwrap_or(0);
    let patch = parts
        .next()
        .and_then(|p| p.parse::<u64>().ok())
        .unwrap_or(0);
    (major.map(|major| (major, minor, patch)), pre)
}

fn now_ms() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

/// Resposta padrão de falha (mesma forma da resposta de sucesso).
pub fn failure(current: &str, message: &str) -> serde_json::Value {
    serde_json::json!({
        "ok": false,
        "current": current,
        "available": false,
        "error": message,
        "pageUrl": WEB_LATEST,
        "checkedAt": now_ms(),
    })
}

/// Onde esta cópia está instalada (para avisar builds de desenvolvimento).
pub fn context() -> serde_json::Map<String, serde_json::Value> {
    let exe = std::env::current_exe().ok();
    let install_dir = std::env::var_os("LOCALAPPDATA").map(|base| PathBuf::from(base).join("NeoGrid"));
    let installed = match (&exe, &install_dir) {
        (Some(exe), Some(dir)) => exe.starts_with(dir),
        _ => false,
    };
    let mut map = serde_json::Map::new();
    map.insert(
        "exePath".into(),
        serde_json::Value::String(
            exe.as_ref()
                .map(|p| p.to_string_lossy().to_string())
                .unwrap_or_default(),
        ),
    );
    map.insert(
        "installDir".into(),
        serde_json::Value::String(
            install_dir
                .map(|p| p.to_string_lossy().to_string())
                .unwrap_or_default(),
        ),
    );
    map.insert("installed".into(), serde_json::Value::Bool(installed));
    map
}

/// Consulta a release mais recente e compara com `current`.
pub fn check(current: &str) -> serde_json::Value {
    let (status, body) = match api_get(API_LATEST) {
        Ok(value) => value,
        Err(error) => return failure(current, &error),
    };
    if status == 404 {
        return serde_json::json!({
            "ok": true,
            "current": current,
            "available": false,
            "message": "Nenhuma versão publicada no GitHub ainda.",
            "pageUrl": WEB_LATEST,
            "checkedAt": now_ms(),
        });
    }
    if !(200..300).contains(&status) {
        let message = if status == 403 || status == 429 {
            "O GitHub limitou temporariamente as consultas. Tente novamente mais tarde."
                .to_string()
        } else {
            format!("GitHub respondeu HTTP {status}.")
        };
        return failure(current, &message);
    }
    let release = match parse_release(&body) {
        Ok(release) => release,
        Err(error) => return failure(current, &error),
    };
    let available = version_cmp(&release.version, current) == Ordering::Greater;
    let mut notes = release.notes.replace('\r', "");
    if notes.chars().count() > 4000 {
        notes = notes.chars().take(4000).collect();
    }
    serde_json::json!({
        "ok": true,
        "current": current,
        "available": available,
        "latest": {
            "version": release.version,
            "tag": release.tag,
            "name": release.name,
            "notes": notes,
            "publishedAt": release.published_at,
            "asset": {
                "name": release.asset_name,
                "url": release.asset_url,
                "size": release.asset_size,
            },
            "pageUrl": WEB_LATEST,
        },
        "pageUrl": WEB_LATEST,
        "checkedAt": now_ms(),
    })
}

fn emit(app: &tauri::AppHandle, phase: &str, downloaded: u64, total: u64) {
    let percent = if total > 0 {
        ((downloaded.min(total) as f64 / total as f64) * 100.0).round() as u64
    } else {
        0
    };
    let _ = app.emit(
        "update:progress",
        serde_json::json!({
            "phase": phase,
            "downloaded": downloaded,
            "total": total,
            "percent": percent,
        }),
    );
}

/// Baixa o instalador da release mais recente e devolve o caminho local.
pub fn install(app: &tauri::AppHandle, current: &str) -> Result<PathBuf, String> {
    emit(app, "check", 0, 0);
    let (status, body) = api_get(API_LATEST)?;
    if status == 404 {
        return Err("Ainda não há versão publicada no GitHub.".to_string());
    }
    if !(200..300).contains(&status) {
        return Err(format!("GitHub respondeu HTTP {status}."));
    }
    let release = parse_release(&body)?;
    if version_cmp(&release.version, current) != Ordering::Greater {
        return Err(format!("A versão instalada ({current}) já está atualizada."));
    }

    let dir = std::env::temp_dir().join("neogrid-update");
    std::fs::create_dir_all(&dir).map_err(|e| format!("pasta de atualização: {e}"))?;
    // Remove restos de tentativas anteriores (instaladores antigos).
    if let Ok(entries) = std::fs::read_dir(&dir) {
        for entry in entries.flatten() {
            let path = entry.path();
            if path.extension().and_then(|e| e.to_str()) == Some("exe") {
                let _ = std::fs::remove_file(path);
            }
        }
    }
    let target = dir.join(format!("NeoGrid_{}_setup.exe", release.version));

    emit(app, "download", 0, release.asset_size);
    let agent = http_agent(Duration::from_secs(1800));
    let resp = agent
        .get(&release.asset_url)
        .header("User-Agent", USER_AGENT)
        .call()
        .map_err(|e| format!("baixar instalador: {e}"))?;
    if !resp.status().is_success() {
        return Err(format!(
            "baixar instalador: HTTP {}",
            resp.status().as_u16()
        ));
    }
    let total = resp
        .headers()
        .get("content-length")
        .and_then(|v| v.to_str().ok())
        .and_then(|v| v.parse::<u64>().ok())
        .filter(|n| *n > 0)
        .unwrap_or(release.asset_size);

    let mut reader = resp.into_body().into_reader();
    let mut file = std::fs::File::create(&target).map_err(|e| format!("criar instalador: {e}"))?;
    let mut buffer = vec![0u8; 1 << 16];
    let mut done: u64 = 0;
    let mut last = Instant::now();
    loop {
        let read = reader
            .read(&mut buffer)
            .map_err(|e| format!("baixar instalador: {e}"))?;
        if read == 0 {
            break;
        }
        file.write_all(&buffer[..read])
            .map_err(|e| format!("gravar instalador: {e}"))?;
        done += read as u64;
        if last.elapsed() >= Duration::from_millis(150) {
            emit(app, "download", done, total);
            last = Instant::now();
        }
    }
    file.flush().map_err(|e| format!("gravar instalador: {e}"))?;
    drop(file);
    emit(app, "verify", done, total);

    if done < MIN_INSTALLER_BYTES {
        let _ = std::fs::remove_file(&target);
        return Err("o download veio incompleto (arquivo pequeno demais).".to_string());
    }
    if total > 0 && done != total {
        let _ = std::fs::remove_file(&target);
        return Err(format!(
            "o download veio incompleto ({done} de {total} bytes)."
        ));
    }
    let mut header = [0u8; 2];
    std::fs::File::open(&target)
        .and_then(|mut f| f.read_exact(&mut header))
        .map_err(|e| format!("conferir instalador: {e}"))?;
    if &header != b"MZ" {
        let _ = std::fs::remove_file(&target);
        return Err("o arquivo baixado não é um executável do Windows.".to_string());
    }
    emit(app, "ready", done, total);
    Ok(target)
}

/// Executa o instalador em modo silencioso depois que o app fechar.
///
/// O NSIS não consegue substituir o `.exe` em uso, então o instalador é
/// iniciado com atraso de ~2 s e o app encerra em seguida.
pub fn launch(installer: &Path) -> Result<(), String> {
    let script = format!(
        "ping -n 3 127.0.0.1 >NUL & start \"\" \"{}\" /S",
        installer.display()
    );
    let mut command = std::process::Command::new("cmd");
    command.args(["/C", &script]);
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt as _;
        const SEM_JANELA: u32 = 0x0800_0000;
        command.creation_flags(SEM_JANELA);
    }
    command
        .spawn()
        .map(|_| ())
        .map_err(|e| format!("iniciar instalador: {e}"))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn compara_versoes() {
        assert_eq!(version_cmp("3.0.1", "3.0.0"), Ordering::Greater);
        assert_eq!(version_cmp("v3.0.0", "3.0.0"), Ordering::Equal);
        assert_eq!(version_cmp("3.0.0", "3.0.1"), Ordering::Less);
        assert_eq!(version_cmp("3.10.0", "3.9.9"), Ordering::Greater);
        assert_eq!(version_cmp("3.0.0", "3.0.0-beta"), Ordering::Greater);
        assert_eq!(version_cmp("3.0.0-beta.2", "3.0.0-beta.1"), Ordering::Greater);
    }

    #[test]
    fn escolhe_setup_entre_assets() {
        let assets = vec![
            serde_json::json!({"name": "leia.txt", "browser_download_url": "u0"}),
            serde_json::json!({"name": "NeoGrid_3.0.1_x64-setup.exe", "browser_download_url": "u1", "size": 7000}),
            serde_json::json!({"name": "NeoGrid_3.0.1_x64.msi", "browser_download_url": "u2"}),
        ];
        let picked = pick_asset(&assets).expect("setup");
        assert_eq!(picked.0, "NeoGrid_3.0.1_x64-setup.exe");
        assert_eq!(picked.1, "u1");
        assert_eq!(picked.2, 7000);
    }

    #[test]
    fn le_release_do_github() {
        let body = serde_json::json!({
            "tag_name": "v3.1.0",
            "name": "NeoGrid 3.1.0",
            "body": "notas",
            "published_at": "2026-11-16T00:00:00Z",
            "assets": [{
                "name": "NeoGrid_3.1.0_x64-setup.exe",
                "browser_download_url": "https://github.com/x/y/releases/download/v3.1.0/NeoGrid_3.1.0_x64-setup.exe",
                "size": 7340032
            }]
        })
        .to_string();
        let release = parse_release(&body).expect("release");
        assert_eq!(release.version, "3.1.0");
        assert_eq!(release.asset_size, 7_340_032);
        assert!(API_LATEST.contains("NeoGRID_By_Valdeci"));
    }
}
