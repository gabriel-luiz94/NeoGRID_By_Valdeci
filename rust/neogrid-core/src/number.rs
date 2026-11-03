//! Espelha `electron/db-build.js: toNumber`
//! (troca `,` por `.`, `Number()` estrito; vazio/lixo = NaN).

/// Retorna `Some(f64)` finito ou `None` (equivale a NaN no JS).
pub fn to_number(value: &str) -> Option<f64> {
    let t = value.trim();
    if t.is_empty() {
        return None;
    }
    let norm = t.replace(',', ".");
    match norm.parse::<f64>() {
        Ok(v) if v.is_finite() => Some(v),
        _ => None,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn virgula_decimal() {
        assert_eq!(to_number("-8,2836298"), Some(-8.2836298));
    }

    #[test]
    fn vazio_e_lixo() {
        assert_eq!(to_number(""), None);
        assert_eq!(to_number("  "), None);
        assert_eq!(to_number("X081508"), None);
    }
}
