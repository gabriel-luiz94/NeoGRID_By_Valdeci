//! Espelha `electron/db-build.js: detectEncoding`.
//! Retorna: "utf-8" | "utf-16le" | "utf-16be" | "windows-1252".

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Encoding {
    Utf8,
    Utf16Le,
    Utf16Be,
    Windows1252,
}

impl Encoding {
    pub fn as_str(self) -> &'static str {
        match self {
            Encoding::Utf8 => "utf-8",
            Encoding::Utf16Le => "utf-16le",
            Encoding::Utf16Be => "utf-16be",
            Encoding::Windows1252 => "windows-1252",
        }
    }
}

/// Detecta encoding a partir do prefixo do arquivo (ate ~1 MiB, como no JS).
pub fn detect_encoding(buf: &[u8]) -> Encoding {
    if buf.len() >= 3 && buf[0] == 0xEF && buf[1] == 0xBB && buf[2] == 0xBF {
        return Encoding::Utf8;
    }
    if buf.len() >= 2 && buf[0] == 0xFF && buf[1] == 0xFE {
        return Encoding::Utf16Le;
    }
    if buf.len() >= 2 && buf[0] == 0xFE && buf[1] == 0xFF {
        return Encoding::Utf16Be;
    }
    // UTF-16 sem BOM: muitos NULs intercalados (mesma heuristica do JS).
    let sample_len = buf.len().min(4096);
    let sample = &buf[..sample_len];
    if !sample.is_empty() {
        let mut even_zero = 0usize;
        let mut odd_zero = 0usize;
        for (i, &b) in sample.iter().enumerate() {
            if b == 0 {
                if i % 2 == 0 {
                    even_zero += 1;
                } else {
                    odd_zero += 1;
                }
            }
        }
        let n = sample.len() as f64;
        if odd_zero as f64 > n * 0.25 {
            return Encoding::Utf16Le;
        }
        if even_zero as f64 > n * 0.25 {
            return Encoding::Utf16Be;
        }
    }
    // Tenta UTF-8 estrito na primeira fatia de 1 MiB; se falhar, windows-1252.
    let head = &buf[..buf.len().min(1 << 20)];
    if std::str::from_utf8(head).is_ok() {
        Encoding::Utf8
    } else {
        Encoding::Windows1252
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn bom_utf8() {
        assert_eq!(
            detect_encoding(&[0xEF, 0xBB, 0xBF, b'a']),
            Encoding::Utf8
        );
    }

    #[test]
    fn bom_utf16le() {
        assert_eq!(detect_encoding(&[0xFF, 0xFE, b'a', 0]), Encoding::Utf16Le);
    }

    #[test]
    fn utf16le_sem_bom() {
        let mut v = Vec::new();
        for b in "OBJECTID;NU_PG_ID".bytes() {
            v.push(b);
            v.push(0);
        }
        assert_eq!(detect_encoding(&v), Encoding::Utf16Le);
    }

    #[test]
    fn latin1_vira_windows1252() {
        // 0xE3 sozinho nao e UTF-8 valido.
        assert_eq!(detect_encoding(b"POST\xE3O;X"), Encoding::Windows1252);
    }

    #[test]
    fn ascii_e_utf8() {
        assert_eq!(detect_encoding(b"OBJECTID;NU_PG_ID;GEO_X"), Encoding::Utf8);
    }
}
