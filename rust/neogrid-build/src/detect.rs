//! Fase 0: varredura de arquivos (encoding, delimitador, headers, camada).
//! Espelha `electron/db-build.js: buildDatabase` (fase 0) + CLI `build-sqlite.js`.

use neogrid_core::{classify::Layer, delimiter, encoding, header};
use std::path::{Path, PathBuf};

use crate::decode;

pub struct FileInfo {
    pub file: PathBuf,
    pub encoding: encoding::Encoding,
    pub delimiter: char,
    pub headers: Vec<String>,
    pub layer: Option<Layer>,
    pub by_name: Option<Layer>,
    pub by_headers: Option<Layer>,
    pub conflict: bool,
    pub size: u64,
}

fn parse_header_line(line: &str, delim: char) -> Vec<String> {
    // Mesma semantica do Papa.parse de uma linha: respeita aspas.
    let mut rdr = csv::ReaderBuilder::new()
        .delimiter(delim as u8)
        .has_headers(false)
        .flexible(true)
        .from_reader(line.as_bytes());
    let mut out = Vec::new();
    if let Some(Ok(rec)) = rdr.records().next() {
        for f in rec.iter() {
            out.push(f.to_string());
        }
    } else {
        out = line.split(delim).map(|s| s.to_string()).collect();
    }
    out
}

fn inspect_file(path: &Path) -> Result<FileInfo, String> {
    let meta = std::fs::metadata(path).map_err(|e| format!("stat: {e}"))?;
    let size = meta.len();
    let fd = std::fs::File::open(path).map_err(|e| format!("abrir: {e}"))?;
    use std::io::Read;
    let mut sample = vec![0u8; 0];
    let mut buf = [0u8; 1 << 20];
    // Le ate 1 MiB como `readSampleBuffer`.
    let mut limited = fd.take(1 << 20);
    let n = limited.read(&mut buf).map_err(|e| format!("ler: {e}"))?;
    sample.extend_from_slice(&buf[..n]);

    let enc = encoding::detect_encoding(&sample);
    let text = decode::decode_bytes(&sample, enc);
    let line = decode::first_line(&text)
        .strip_prefix('\u{FEFF}')
        .unwrap_or(decode::first_line(&text))
        .to_string();
    let delim = delimiter::sniff_delimiter(&line);
    let raw = parse_header_line(&line, delim);
    let refs: Vec<&str> = raw.iter().map(|s| s.as_str()).collect();
    let headers = header::unique_headers(&refs);
    let by_name = neogrid_core::classify::classify_file_by_name(&path.to_string_lossy());
    let by_headers = neogrid_core::classify::classify_by_headers(&headers);
    // Regra do JS: cabecalho vence (`byHeaders || byName`).
    let layer = by_headers.or(by_name);
    let conflict = matches!((by_name, by_headers), (Some(a), Some(b)) if a != b);
    Ok(FileInfo {
        file: path.to_path_buf(),
        encoding: enc,
        delimiter: delim,
        headers,
        layer,
        by_name,
        by_headers,
        conflict,
        size,
    })
}

pub fn scan_sources(source: &Path) -> Result<Vec<FileInfo>, String> {
    let mut csvs = Vec::new();
    let mut stack = vec![source.to_path_buf()];
    while let Some(dir) = stack.pop() {
        let entries =
            std::fs::read_dir(&dir).map_err(|e| format!("listar {}: {e}", dir.display()))?;
        for entry in entries {
            let entry = entry.map_err(|e| format!("entrada: {e}"))?;
            let p = entry.path();
            if p.is_dir() {
                stack.push(p);
            } else if p
                .extension()
                .map(|e| e.eq_ignore_ascii_case("csv"))
                .unwrap_or(false)
            {
                csvs.push(p);
            }
        }
    }
    if csvs.is_empty() {
        return Err("Nenhum CSV encontrado.".to_string());
    }
    csvs.sort();
    let mut infos = Vec::with_capacity(csvs.len());
    for p in &csvs {
        infos.push(inspect_file(p)?);
    }
    Ok(infos)
}
