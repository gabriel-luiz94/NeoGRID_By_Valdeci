//! Espelha `electron/db-build.js: sniffDelimiter` e
//! `src/js/data/workers/csv-worker.js: sniffDelimiter`.
//! Conta `;` `,` `\t` fora de aspas na primeira linha.

/// Retorna `;`, `,` ou `\t`. Padrao `;` (igual ao JS quando vazio).
pub fn sniff_delimiter(first_line: &str) -> char {
    let mut in_quotes = false;
    let mut sc = 0u32;
    let mut co = 0u32;
    let mut tb = 0u32;
    let chars: Vec<char> = first_line.chars().collect();
    let mut i = 0;
    while i < chars.len() {
        let c = chars[i];
        if c == '"' {
            if in_quotes && i + 1 < chars.len() && chars[i + 1] == '"' {
                i += 1; // aspas escapadas
            } else {
                in_quotes = !in_quotes;
            }
        } else if !in_quotes {
            match c {
                ';' => sc += 1,
                ',' => co += 1,
                '\t' => tb += 1,
                _ => {}
            }
        }
        i += 1;
    }
    // Mesma precedencia do db-build.js: `;` >= `,` e `;` >= tab vence.
    if sc >= co && sc >= tb && sc > 0 {
        return ';';
    }
    if tb >= co && tb > 0 {
        return '\t';
    }
    if co > 0 {
        return ',';
    }
    ';'
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn base_neoenergia_usa_ponto_virgula() {
        assert_eq!(sniff_delimiter("OBJECTID;NU_PG_ID;GEO_X"), ';');
    }

    #[test]
    fn respeita_aspas() {
        assert_eq!(sniff_delimiter("\"a;b\",c,d"), ',');
    }

    #[test]
    fn tab() {
        assert_eq!(sniff_delimiter("A\tB\tC"), '\t');
    }

    #[test]
    fn vazio_padrao() {
        assert_eq!(sniff_delimiter(""), ';');
    }
}
