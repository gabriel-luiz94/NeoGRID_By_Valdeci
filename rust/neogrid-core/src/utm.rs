//! Espelha `src/js/modules/dxf/utm.js: utm/utmZone` (Transversa de Mercator,
//! SIRGAS2000/GRS80 — mesmos coeficientes do JS).

pub const RAD: f64 = std::f64::consts::PI / 180.0;

pub fn utm_zone(lon: f64) -> i32 {
    ((lon + 180.0) / 6.0).floor() as i32 + 1
}

pub fn utm(lat: f64, lon: f64, zone: i32) -> (f64, f64) {
    let a = 6_378_137.0;
    let f = 1.0 / 298.257222101;
    let k0 = 0.9996;
    let e2 = f * (2.0 - f);
    let ep = e2 / (1.0 - e2);
    let phi = lat * RAD;
    let dlon = (lon - ((zone - 1) as f64 * 6.0 - 180.0 + 3.0)) * RAD;
    let sin = phi.sin();
    let cos = phi.cos();
    let tan = phi.tan();
    let big_n = a / (1.0 - e2 * sin * sin).sqrt();
    let t = tan * tan;
    let c = ep * cos * cos;
    let big_a = dlon * cos;
    let m = a * ((1.0 - e2 / 4.0 - (3.0 * e2 * e2) / 64.0 - (5.0 * e2 * e2 * e2) / 256.0) * phi
        - ((3.0 * e2) / 8.0 + (3.0 * e2 * e2) / 32.0 + (45.0 * e2 * e2 * e2) / 1024.0) * (2.0 * phi).sin()
        + ((15.0 * e2 * e2) / 256.0 + (45.0 * e2 * e2 * e2) / 1024.0) * (4.0 * phi).sin()
        - (35.0 * e2 * e2 * e2) / 3072.0 * (6.0 * phi).sin());
    let x = k0
        * big_n
        * (big_a
            + ((1.0 - t + c) * big_a.powi(3)) / 6.0
            + ((5.0 - 18.0 * t + t * t + 72.0 * c - 58.0 * ep) * big_a.powi(5)) / 120.0)
        + 500_000.0;
    let mut y = k0
        * (m + big_n
            * tan
            * (big_a * big_a / 2.0
                + ((5.0 - t + 9.0 * c + 4.0 * c * c) * big_a.powi(4)) / 24.0
                + ((61.0 - 58.0 * t + t * t + 600.0 * c - 330.0 * ep) * big_a.powi(6)) / 720.0));
    if lat < 0.0 {
        y += 10_000_000.0;
    }
    (x, y)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn zona_recife() {
        assert_eq!(utm_zone(-34.9), 25);
    }

    #[test]
    fn hemisferio_sul_soma_10mi() {
        let (_, y_sul) = utm(-8.28, -39.36, 24);
        let (_, y_norte) = utm(8.28, -39.36, 24);
        assert!(y_sul > 9_000_000.0 && y_norte < 1_000_000.0);
    }
}
