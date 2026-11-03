//! Estatisticas por camada (espelha o objeto `stats` + hotspots/bounds do JS).
//!
//! Nota de paridade: o JS aplica `bump()` sobre a linha JA codificada em
//! dicionario, entao distribuicoes de colunas-dicionario guardam os CODIGOS
//! ("3") e nao o texto. Espelhamos exatamente isso. A ordem de desempate das
//! distribuicoes segue a primeira aparicao (sort estavel do V8).

use std::collections::{HashMap, HashSet};

/// Mapa contagem com ordem de primeira insercao (como o `Map` do JS).
#[derive(Default)]
pub struct OrderedCounts {
    order: Vec<String>,
    counts: HashMap<String, u64>,
}

impl OrderedCounts {
    pub fn bump(&mut self, value: &str) {
        let label = value.trim();
        let label: String = if label.is_empty() {
            "Não informado".to_string()
        } else {
            label.to_string()
        };
        if !self.counts.contains_key(&label) {
            self.order.push(label.clone());
        }
        *self.counts.entry(label).or_insert(0) += 1;
    }

    /// Top 80 por contagem desc; empate = primeira aparicao (estavel).
    pub fn top(&self) -> Vec<(String, u64)> {        let mut idx: Vec<usize> = (0..self.order.len()).collect();
        idx.sort_by(|&a, &b| {
            self.counts[&self.order[b]]
                .cmp(&self.counts[&self.order[a]])
                .then(a.cmp(&b))
        });
        idx.into_iter()
            .take(80)
            .map(|i| (self.order[i].clone(), self.counts[&self.order[i]]))
            .collect()
    }
}

pub struct Stats {
    pub count: u64,
    pub located: u64,
    pub missing: u64,
    pub duplicates: u64,
    pub id_present: u64,
    pub length_meters: f64,
    pub material: OrderedCounts,
    pub pole_type: OrderedCounts,
    pub installation_type: OrderedCounts,
    pub conductor: OrderedCounts,
    ids: HashSet<String>,
    hotspots: HashMap<(i64, i64), u64>,
    hotspot_order: Vec<(i64, i64)>,
    pub west: f64,
    pub south: f64,
    pub east: f64,
    pub north: f64,
}

impl Stats {
    pub fn new() -> Self {
        Self {
            count: 0,
            located: 0,
            missing: 0,
            duplicates: 0,
            id_present: 0,
            length_meters: 0.0,
            material: OrderedCounts::default(),
            pole_type: OrderedCounts::default(),
            installation_type: OrderedCounts::default(),
            conductor: OrderedCounts::default(),
            ids: HashSet::new(),
            hotspots: HashMap::new(),
            hotspot_order: Vec::new(),
            west: f64::INFINITY,
            south: f64::INFINITY,
            east: f64::NEG_INFINITY,
            north: f64::NEG_INFINITY,
        }
    }

    pub fn register_id(&mut self, id: &str) {
        if id.is_empty() {
            return;
        }
        if !self.ids.insert(id.to_string()) {
            self.duplicates += 1;
        } else {
            self.id_present += 1;
        }
    }

    pub fn hotspot(&mut self, lon: f64, lat: f64) {
        let key = ((lon * 100.0).floor() as i64, (lat * 100.0).floor() as i64);
        if !self.hotspots.contains_key(&key) {
            self.hotspot_order.push(key);
        }
        *self.hotspots.entry(key).or_insert(0) += 1;
    }

    pub fn bound(&mut self, lon: f64, lat: f64) {
        if !lon.is_finite() || !lat.is_finite() {
            return;
        }
        if lon < self.west {
            self.west = lon;
        }
        if lon > self.east {
            self.east = lon;
        }
        if lat < self.south {
            self.south = lat;
        }
        if lat > self.north {
            self.north = lat;
        }
    }

    pub fn has_bounds(&self) -> bool {
        self.west.is_finite()
    }

    /// Top 400 hotspots: contagem desc, empate = primeira aparicao.
    pub fn hotspots_top(&self) -> Vec<(i64, i64, u64)> {
        let mut idx: Vec<usize> = (0..self.hotspot_order.len()).collect();
        idx.sort_by(|&a, &b| {
            let ka = self.hotspot_order[a];
            let kb = self.hotspot_order[b];
            self.hotspots[&kb].cmp(&self.hotspots[&ka]).then(a.cmp(&b))
        });
        idx.into_iter()
            .take(400)
            .map(|i| {
                let (x, y) = self.hotspot_order[i];
                (x, y, self.hotspots[&(x, y)])
            })
            .collect()
    }

    pub fn clear_transient(&mut self) {
        self.ids.clear();
        self.hotspots.clear();
        self.hotspot_order.clear();
    }
}
