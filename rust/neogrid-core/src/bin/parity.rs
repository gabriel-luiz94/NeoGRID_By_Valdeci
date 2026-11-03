//! Binario de paridade: `neogrid-parity <arquivo.csv> [--sample N]`.
//! Replica a Fase 0 do JS (encoding, delimitador, headers, camada)
//! e conta pares WKT — para comparar contra `node` lado a lado.
//! Saida: JSON em stdout, uma linha.

use neogrid_core::{classify, delimiter, encoding, header, wkt};
use std::io::Read;
use std::time::Instant;

fn main() {
    let args: Vec<String> = std::env::args().collect();
    if args.len() < 2 {
        eprintln!("uso: neogrid-parity <arquivo.csv> [--sample N]");
        std::process::exit(2);
    }
    let path = &args[1];
    let mut sample_rows: usize = 20_000;
    for w in args.windows(2) {
        if w[0] == "--sample" {
            sample_rows = w[1].parse().unwrap_or(sample_rows);
        }
    }
    let t0 = Instant::now();
    let mut f = std::fs::File::open(path).expect("abrir csv");
    let mut head = vec![0u8; 1 << 20];
    let hn = f.read(&mut head).unwrap_or(0);
    head.truncate(hn);
    let enc = encoding::detect_encoding(&head);

    // Decodifica a primeira linha para sniff (BOM + latin1 tratados de forma simples).
    let text = if head.starts_with(&[0xEF, 0xBB, 0xBF]) {
        String::from_utf8_lossy(&head[3..]).to_string()
    } else if enc == encoding::Encoding::Utf16Le || enc == encoding::Encoding::Utf16Be {
        // amostra suficiente para o sniff; decodificacao completa vira na fase B (futura).
        String::from_utf8_lossy(&head).to_string()
    } else if enc == encoding::Encoding::Utf8 {
        String::from_utf8_lossy(&head).to_string()
    } else {
        head.iter().map(|&b| b as char).collect()
    };
    let first_line = text.split(['\r', '\n']).next().unwrap_or("").to_string();
    let delim = delimiter::sniff_delimiter(&first_line.strip_prefix('\u{FEFF}').unwrap_or(&first_line));

    // Headers: split simples respeitando aspas (suficiente para a linha de cabecalho).
    let raw_headers = split_csv_line(&first_line, delim);
    let refs: Vec<&str> = raw_headers.iter().map(|s| s.as_str()).collect();
    let headers = header::unique_headers(&refs);
    let by_name = classify::classify_file_by_name(path);
    let by_headers = classify::classify_by_headers(&headers);
    // Mesma regra do JS: cabecalho vence; conflito so gera aviso.
    let layer = by_headers.or(by_name);
    let conflict = matches!((by_name, by_headers), (Some(a), Some(b)) if a != b);

    // Amostra de linhas: conta WKTs escaneaveis e soma bbox (prova que o scan roda).
    let t1 = Instant::now();
    let content = std::fs::read(path).unwrap_or_default();
    let body = decode_for_scan(&content, enc);
    let mut rows = 0usize;
    let mut wkt_ok = 0usize;
    let mut wkt_col = headers.iter().position(|h| h == "GEOMETRIA_WKT");
    if wkt_col.is_none() {
        // postes: ultima coluna costuma ser o POINT mesmo sem header WKT canonico
        wkt_col = None;
    }
    for line in body.lines().skip(1).take(sample_rows) {
        if line.trim().is_empty() {
            continue;
        }
        rows += 1;
        let cells = split_csv_line(line, delim);
        let cand = wkt_col
            .and_then(|c| cells.get(c).map(|s| s.as_str()))
            .or_else(|| cells.last().map(|s| s.as_str()))
            .unwrap_or("");
        if wkt::scan_wkt(cand).is_some() {
            wkt_ok += 1;
        }
    }
    let dt = t0.elapsed();

    println!(
        "{{\"file\":{:?},\"encoding\":{:?},\"delimiter\":{:?},\"headers\":{},\"byName\":{},\"byHeaders\":{},\"layer\":{},\"conflict\":{},\"sampleRows\":{},\"wktOk\":{},\"detectMs\":{},\"totalMs\":{}}}",
        path,
        enc.as_str(),
        delim.to_string(),
        headers.len(),
        opt_layer(by_name),
        opt_layer(by_headers),
        opt_layer(layer),
        conflict,
        rows,
        wkt_ok,
        t1.duration_since(t0).as_millis(),
        dt.as_millis(),
    );
}

fn opt_layer(l: Option<classify::Layer>) -> String {
    match l {
        Some(v) => format!("{:?}", v.as_str()),
        None => "null".to_string(),
    }
}

fn decode_for_scan(bytes: &[u8], enc: encoding::Encoding) -> String {
    match enc {
        encoding::Encoding::Utf8 => String::from_utf8_lossy(bytes).to_string(),
        encoding::Encoding::Windows1252 => bytes.iter().map(|&b| b as char).collect(),
        encoding::Encoding::Utf16Le => {
            let u16: Vec<u16> = bytes
                .chunks_exact(2)
                .map(|c| u16::from_le_bytes([c[0], c[1]]))
                .collect();
            String::from_utf16_lossy(&u16)
        }
        encoding::Encoding::Utf16Be => {
            let u16: Vec<u16> = bytes
                .chunks_exact(2)
                .map(|c| u16::from_be_bytes([c[0], c[1]]))
                .collect();
            String::from_utf16_lossy(&u16)
        }
    }
}

fn split_csv_line(line: &str, delim: char) -> Vec<String> {
    let mut out = Vec::new();
    let mut cur = String::new();
    let mut in_q = false;
    let mut chars = line.chars().peekable();
    while let Some(c) = chars.next() {
        if c == '"' {
            if in_q && chars.peek() == Some(&'"') {
                chars.next();
                cur.push('"');
            } else {
                in_q = !in_q;
            }
        } else if c == delim && !in_q {
            out.push(cur);
            cur = String::new();
        } else {
            cur.push(c);
        }
    }
    out.push(cur);
    out
}
