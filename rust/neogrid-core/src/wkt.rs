//! Espelha `electron/db-build.js: scanWkt`.
//! Semantica JS preservada de proposito: percorre o texto apos `SRID=...;`
//! e emparelha os numeros em (lon, lat) — (par=lon, impar=lat).
//! Nao valida o tipo geometrico; so extrai bbox + primeiro ponto.

#[derive(Debug, Clone, Copy, PartialEq)]
pub struct WktScan {
    pub first_lon: f64,
    pub first_lat: f64,
    pub min_lon: f64,
    pub min_lat: f64,
    pub max_lon: f64,
    pub max_lat: f64,
}

fn parse_num(slice: &str) -> Option<f64> {
    match slice.parse::<f64>() {
        Ok(v) if v.is_finite() => Some(v),
        _ => None,
    }
}

/// Retorna `None` se nao houver ao menos um par finito (igual ao JS).
pub fn scan_wkt(raw: &str) -> Option<WktScan> {
    if raw.is_empty() {
        return None;
    }
    let mut src = raw;
    if src.len() >= 5 && src[..5].eq_ignore_ascii_case("SRID=") {
        if let Some(pos) = src.find(';') {
            src = &src[pos + 1..];
        }
    }
    let b = src.as_bytes();
    let n = b.len();
    let mut i = 0;
    let mut pair: u64 = 0;
    let mut first_lon: Option<f64> = None;
    let mut first_lat: Option<f64> = None;
    let mut min_lon = f64::INFINITY;
    let mut min_lat = f64::INFINITY;
    let mut max_lon = f64::NEG_INFINITY;
    let mut max_lat = f64::NEG_INFINITY;

    #[inline]
    fn is_num_start(c: u8) -> bool {
        c.is_ascii_digit() || c == b'-' || c == b'+' || c == b'.'
    }
    #[inline]
    fn is_num_cont(c: u8) -> bool {
        c.is_ascii_digit()
            || c == b'.'
            || c == b'-'
            || c == b'+'
            || c == b'e'
            || c == b'E'
    }

    while i < n {
        let c = b[i];
        if is_num_start(c) {
            let start = i;
            i += 1;
            while i < n && is_num_cont(b[i]) {
                i += 1;
            }
            if let Some(v) = parse_num(&src[start..i]) {
                if pair % 2 == 0 {
                    if first_lon.is_none() {
                        first_lon = Some(v);
                    }
                    if v < min_lon {
                        min_lon = v;
                    }
                    if v > max_lon {
                        max_lon = v;
                    }
                } else {
                    if first_lat.is_none() {
                        first_lat = Some(v);
                    }
                    if v < min_lat {
                        min_lat = v;
                    }
                    if v > max_lat {
                        max_lat = v;
                    }
                }
                pair += 1;
            }
        } else {
            i += 1;
        }
    }

    if !min_lon.is_finite() || !min_lat.is_finite() || !max_lon.is_finite() || !max_lat.is_finite() {
        return None;
    }
    Some(WktScan {
        first_lon: first_lon.unwrap_or(min_lon),
        first_lat: first_lat.unwrap_or(min_lat),
        min_lon,
        min_lat,
        max_lon,
        max_lat,
    })
}

/// Espelha `src/js/data/geometry.js: wktFirstPoint` — primeiro par `X Y`.
pub fn wkt_first_point(raw: &str) -> Option<(f64, f64)> {
    let s = raw.strip_prefix("SRID=").and_then(|t| t.find(';').map(|p| &t[p + 1..])).unwrap_or(raw);
    // procura dois numeros separados por espacos (regex do JS simplificada)
    let b = s.as_bytes();
    let mut nums: Vec<f64> = Vec::with_capacity(2);
    let mut i = 0;
    while i < b.len() && nums.len() < 2 {
        let c = b[i];
        if c.is_ascii_digit() || c == b'-' || c == b'+' || c == b'.' {
            let start = i;
            i += 1;
            while i < b.len()
                && (b[i].is_ascii_digit()
                    || b[i] == b'.'
                    || b[i] == b'-'
                    || b[i] == b'+'
                    || b[i] == b'e'
                    || b[i] == b'E')
            {
                i += 1;
            }
            if let Some(v) = parse_num(&s[start..i]) {
                nums.push(v);
            }
        } else {
            i += 1;
        }
    }
    if nums.len() == 2 {
        Some((nums[0], nums[1]))
    } else {
        None
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn point_real_da_base() {
        let s = scan_wkt("POINT(-39.3612676 -8.2840788)").unwrap();
        assert!((s.first_lon - -39.3612676).abs() < 1e-9);
        assert!((s.first_lat - -8.2840788).abs() < 1e-9);
        assert_eq!(s.min_lon, s.max_lon);
    }

    #[test]
    fn linestring_bbox() {
        let s = scan_wkt("LINESTRING(-39.36 -8.28, -39.35 -8.27)").unwrap();
        assert!((s.min_lon - -39.36).abs() < 1e-9);
        assert!((s.max_lat - -8.27).abs() < 1e-9);
    }

    #[test]
    fn srid_prefix() {
        let s = scan_wkt("SRID=4674;POINT(-39.36 -8.28)").unwrap();
        assert!((s.first_lon - -39.36).abs() < 1e-9);
    }

    #[test]
    fn lixo_retorna_none() {
        assert!(scan_wkt("").is_none());
        assert!(scan_wkt("POINT EMPTY").is_none());
    }

    #[test]
    fn first_point() {
        assert_eq!(
            wkt_first_point("POINT(-39.213445 -8.1192967)"),
            Some((-39.213445, -8.1192967))
        );
    }
}
