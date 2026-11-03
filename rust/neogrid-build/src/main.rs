//! CLI do conversor CSV -> SQLite (fino sobre `neogrid_build`).
//! Uso: neogrid-build <pasta_csv> <saida.sqlite> [--manifesto-base a.json]
//!   [--manifesto-out m.json] [--reject-limit 0.005]
//! Espelha `scripts/build-sqlite.js`.

use neogrid_build::{build_database, BuildError, Options, ProgressEvent};
use std::path::PathBuf;
use std::sync::{Arc, Mutex};

fn parse_args(argv: &[String]) -> Result<Options, String> {
    let mut source: Option<PathBuf> = None;
    let mut output: Option<PathBuf> = None;
    let mut manifesto_base: Option<PathBuf> = None;
    let mut manifesto_out: Option<PathBuf> = None;
    let mut reject_limit = 0.005;
    let mut positional = Vec::new();
    let mut i = 0;
    while i < argv.len() {
        match argv[i].as_str() {
            "--manifesto-base" => {
                i += 1;
                manifesto_base = Some(PathBuf::from(
                    argv.get(i).ok_or("--manifesto-base exige valor")?,
                ));
            }
            "--manifesto-out" => {
                i += 1;
                manifesto_out = Some(PathBuf::from(
                    argv.get(i).ok_or("--manifesto-out exige valor")?,
                ));
            }
            "--reject-limit" => {
                i += 1;
                reject_limit = argv
                    .get(i)
                    .ok_or("--reject-limit exige valor")?
                    .parse()
                    .map_err(|_| "--reject-limit inválido")?;
            }
            other if other.starts_with("--") => return Err(format!("opção desconhecida: {other}")),
            _ => positional.push(argv[i].clone()),
        }
        i += 1;
    }
    if positional.len() >= 2 {
        source = Some(PathBuf::from(&positional[0]));
        output = Some(PathBuf::from(&positional[1]));
    }
    match (source, output) {
        (Some(s), Some(o)) => Ok(Options {
            source: s,
            output: o,
            manifesto_base,
            manifesto_out,
            reject_limit,
            cancel: None,
            on_progress: None,
        }),
        _ => Err("Uso: neogrid-build <pasta_csv> <saida.sqlite> [--manifesto-base anterior.json] [--manifesto-out manifesto.json] [--reject-limit 0.005]".to_string()),
    }
}

fn format_int(value: u64) -> String {
    let mut s = value.to_string();
    let mut out = String::new();
    while s.len() > 3 {
        let tail = s.split_off(s.len() - 3);
        out = format!(".{}{}", tail, out);
    }
    format!("{}{}", s, out)
}

fn main() {
    let argv: Vec<String> = std::env::args().skip(1).collect();
    let mut opts = match parse_args(&argv) {
        Ok(o) => o,
        Err(e) => {
            eprintln!("{}", e);
            std::process::exit(2);
        }
    };
    // Imprime a cada 10% para não poluir o terminal (como o CLI JS).
    let last_bucket = Arc::new(Mutex::new(usize::MAX));
    let bucket_ref = last_bucket.clone();
    opts.on_progress = Some(Arc::new(move |event| match event {
        ProgressEvent::Log(message) => println!("[sqlite] {message}"),
        ProgressEvent::Phase { .. } => {
            *bucket_ref.lock().unwrap() = usize::MAX;
        }
        ProgressEvent::Progress { scan: _, layer, file, bytes, total_bytes } => {
            if total_bytes == 0 {
                return;
            }
            let percent = (bytes * 100 / total_bytes) as usize;
            let bucket = percent / 10;
            let mut last = last_bucket.lock().unwrap();
            if bucket != *last {
                *last = bucket;
                println!("[sqlite] {layer}/{file}: {percent}%");
            }
        }
    }));
    match build_database(&opts) {
        Ok(result) => {
            println!(
                "[sqlite] OK: {} ({} registros, manifesto em {})",
                result.output.display(),
                format_int(result.rows),
                result.manifesto_out.display()
            );
        }
        Err(BuildError::Cancelled) => {
            eprintln!("[sqlite] conversão cancelada.");
            std::process::exit(1);
        }
        Err(e) => {
            eprintln!("[sqlite] falhou: {}", e);
            std::process::exit(1);
        }
    }
}
