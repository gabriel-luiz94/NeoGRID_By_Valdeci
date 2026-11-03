//! Decodificacao de arquivos para UTF-8 (espelha `db-build.js` +
//! `TextDecoder(encoding)`). Retorna String pronta para o parser CSV.

use encoding_rs::{UTF_16BE, UTF_16LE, WINDOWS_1252};
use neogrid_core::encoding::Encoding;

/// Decodifica o conteudo completo. BOM UTF-8 removido (o JS faz
/// `replace(/^\uFEFF/, '')` na primeira linha; aqui removemos no texto).
pub fn decode_bytes(bytes: &[u8], enc: Encoding) -> String {
    match enc {
        Encoding::Utf8 => {
            let s = String::from_utf8_lossy(bytes);
            s.strip_prefix('\u{FEFF}').unwrap_or(&s).to_string()
        }
        Encoding::Windows1252 => {
            let (s, _) = WINDOWS_1252.decode_without_bom_handling(bytes);
            s.strip_prefix('\u{FEFF}').unwrap_or(&s).to_string()
        }
        Encoding::Utf16Le => {
            let (s, _) = UTF_16LE.decode_without_bom_handling(bytes);
            s.strip_prefix('\u{FEFF}').unwrap_or(&s).to_string()
        }
        Encoding::Utf16Be => {
            let (s, _) = UTF_16BE.decode_without_bom_handling(bytes);
            s.strip_prefix('\u{FEFF}').unwrap_or(&s).to_string()
        }
    }
}

/// Primeira linha logica do texto (para sniff de delimitador).
pub fn first_line(text: &str) -> &str {
    match text.find('\n') {
        Some(pos) => {
            let line = &text[..pos];
            line.strip_suffix('\r').unwrap_or(line)
        }
        None => text,
    }
}
