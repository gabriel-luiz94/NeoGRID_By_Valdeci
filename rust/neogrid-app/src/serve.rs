//! Servidor estático do frontend em `http://localhost:1420` — a mesma origem
//! usada em dev e produção.
//!
//! - **Produção**: serve a cópia embutida no binário (`include_dir!`).
//! - **Dev**: com `NEOGRID_SRC_DIR` apontando para `src/`, serve do disco, então
//!   editar o frontend e recarregar (Ctrl+R) basta — sem rebuild.
//! - Se a porta já estiver ocupada por outro servidor, cede a vez.

use include_dir::{include_dir, Dir};

static DIST: Dir<'_> = include_dir!("$CARGO_MANIFEST_DIR/../../src");

/// Diretório de dev (quando `NEOGRID_SRC_DIR` está setado e existe).
fn dev_dir() -> Option<std::path::PathBuf> {
    let dir = std::env::var_os("NEOGRID_SRC_DIR")?;
    let path = std::path::PathBuf::from(dir);
    if path.is_dir() {
        Some(path)
    } else {
        None
    }
}

fn mime(path: &str) -> &'static str {
    if path.ends_with(".html") {
        "text/html; charset=utf-8"
    } else if path.ends_with(".css") {
        "text/css; charset=utf-8"
    } else if path.ends_with(".js") || path.ends_with(".mjs") {
        "text/javascript; charset=utf-8"
    } else if path.ends_with(".json") || path.ends_with(".map") {
        "application/json; charset=utf-8"
    } else if path.ends_with(".svg") {
        "image/svg+xml"
    } else if path.ends_with(".png") {
        "image/png"
    } else if path.ends_with(".jpg") || path.ends_with(".jpeg") {
        "image/jpeg"
    } else if path.ends_with(".webp") {
        "image/webp"
    } else if path.ends_with(".ico") {
        "image/x-icon"
    } else if path.ends_with(".woff2") {
        "font/woff2"
    } else if path.ends_with(".woff") {
        "font/woff"
    } else if path.ends_with(".csv") {
        "text/csv; charset=utf-8"
    } else {
        "application/octet-stream"
    }
}

fn respond_bytes(rel: &str, body: Vec<u8>) -> tiny_http::Response<std::io::Cursor<Vec<u8>>> {
    tiny_http::Response::from_data(body).with_header(
        tiny_http::Header::from_bytes(&b"Content-Type"[..], mime(rel).as_bytes())
            .expect("mime válido"),
    )
}

fn serve_file(path: &str) -> tiny_http::Response<std::io::Cursor<Vec<u8>>> {
    let clean = path.split(['?', '#']).next().unwrap_or("");
    let rel = clean.trim_start_matches('/');
    let rel = if rel.is_empty() { "index.html" } else { rel };
    // Sem `..`: nada sai do diretório do frontend.
    if rel.split('/').any(|seg| seg == "..") {
        return tiny_http::Response::from_string("Forbidden").with_status_code(403);
    }
    if let Some(base) = dev_dir() {
        // Dev: sempre do disco (edits aparecem no próximo reload).
        return match std::fs::read(base.join(rel)) {
            Ok(bytes) => respond_bytes(rel, bytes),
            Err(_) => tiny_http::Response::from_string("Not found").with_status_code(404),
        };
    }
    match DIST.get_file(rel) {
        Some(file) => respond_bytes(rel, file.contents().to_vec()),
        None => tiny_http::Response::from_string("Not found").with_status_code(404),
    }
}

/// Sobe o servidor em thread dedicada e devolve a porta escolhida.
///
/// - Sempre usa porta efêmera (0) por padrão: nunca conflita com outra
///   ferramenta. `NEOGRID_FRONTEND_PORT` força uma porta específica.
/// - Se a porta preferida estiver ocupada, cai para efêmera.
pub fn spawn_server() -> Option<u16> {
    let preferred = std::env::var("NEOGRID_FRONTEND_PORT")
        .ok()
        .and_then(|v| v.parse::<u16>().ok());
    let server = preferred
        .and_then(|port| tiny_http::Server::http(("127.0.0.1", port)).ok())
        .or_else(|| tiny_http::Server::http(("127.0.0.1", 0)).ok())?;
    let port = server.server_addr().to_ip()?.port();
    std::thread::Builder::new()
        .name("neogrid-frontend".to_string())
        .spawn(move || {
            for request in server.incoming_requests() {
                let response = serve_file(request.url());
                let _ = request.respond(response);
            }
        })
        .ok()?;
    Some(port)
}
