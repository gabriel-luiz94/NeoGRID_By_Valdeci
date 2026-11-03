//! Espelha `electron/db-build.js: normalizeHeader/uniqueHeaders`
//! e `csv-worker.js: cleanHeader/uniqueHeaders`.
//! BOM removido, trim, UPPERCASE; duplicadas ganham sufixo `_2`, `_3`...

/// Remove BOM, apara e converte para maiusculas (ASCII + Unicode via `to_uppercase`).
pub fn normalize_header(value: &str) -> String {
    value.strip_prefix('\u{FEFF}').unwrap_or(value).trim().to_uppercase()
}

pub fn unique_headers(raw: &[&str]) -> Vec<String> {
    use std::collections::HashMap;
    let mut counts: HashMap<String, usize> = HashMap::new();
    raw.iter()
        .enumerate()
        .map(|(i, v)| {
            let mut base = normalize_header(v);
            if base.is_empty() {
                base = format!("COLUNA_{}", i + 1);
            }
            let seen = counts.get(&base).copied().unwrap_or(0);
            counts.insert(base.clone(), seen + 1);
            if seen == 0 {
                base
            } else {
                format!("{}_{}", base, seen + 1)
            }
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn maiusculas_e_bom() {
        assert_eq!(normalize_header("\u{FEFF}  geo_x "), "GEO_X");
        assert_eq!(normalize_header("Nu_Pg_Id"), "NU_PG_ID");
    }

    #[test]
    fn duplicadas_ganham_sufixo() {
        let out = unique_headers(&["a", "A", "b", ""]);
        assert_eq!(out, vec!["A", "A_2", "B", "COLUNA_4"]);
    }
}
