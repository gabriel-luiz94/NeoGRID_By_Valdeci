//! Fase A: varredura de cardinalidade para codificacao em dicionario.
//! Espelha `db-build.js` (fase A): colunas com 1..=2000 distintos viram
//! dicionario; acima de 5000 viram inelegiveis na hora.
//!
//! Mapa inverso pre-computado (alvo -> fonte): O(colunas) por linha em vez
//! de O(colunas^2) com `indexOf` como no JS.

use std::collections::{HashMap, HashSet};

use crate::layers::{DICT_MAX_DISTINCT, DICT_TRACK_CAP};

/// Colunas elegiveis (indices na uniao) -> valores ordenados.
pub type DictColumns = HashMap<usize, Vec<String>>;

pub struct PhaseA {
    distinct: Vec<Option<HashSet<String>>>,
    ineligible: HashSet<usize>,
}

impl PhaseA {
    pub fn new(ncols: usize, ineligible: impl IntoIterator<Item = usize>) -> Self {
        Self {
            distinct: (0..ncols).map(|_| Some(HashSet::new())).collect(),
            ineligible: ineligible.into_iter().collect(),
        }
    }

    /// Uma linha valida. `inverse[c]` = posicao-fonte que alimenta a coluna
    /// da uniao `c` (ou None quando o arquivo nao tem a coluna).
    pub fn feed(&mut self, record: &csv::StringRecord, inverse: &[Option<usize>]) {
        for (c, slot) in self.distinct.iter_mut().enumerate() {
            if self.ineligible.contains(&c) {
                continue;
            }
            let set = match slot {
                Some(s) => s,
                None => continue,
            };
            let value = match inverse[c] {
                Some(s) => record.get(s).unwrap_or(""),
                None => continue,
            };
            if value.is_empty() {
                continue;
            }
            // `contains` com &str evita clonar para sondar.
            if set.contains(value) {
                continue;
            }
            if set.len() >= DICT_TRACK_CAP {
                // Equivale ao JS (inserir e derrubar ao passar de 5000).
                *slot = None;
                self.ineligible.insert(c);
                continue;
            }
            set.insert(value.to_string());
        }
    }

    /// Valor que não vem de uma coluna do CSV (ex.: regional da pasta do arquivo).
    pub fn seed(&mut self, column: usize, value: &str) {
        if let Some(Some(set)) = self.distinct.get_mut(column) {
            set.insert(value.to_string());
        }
    }

    pub fn finish(self) -> DictColumns {        let mut out = DictColumns::new();
        for (c, set) in self.distinct.into_iter().enumerate() {
            if let Some(set) = set {
                if !set.is_empty() && set.len() <= DICT_MAX_DISTINCT {
                    let mut values: Vec<String> = set.into_iter().collect();
                    values.sort();
                    out.insert(c, values);
                }
            }
        }
        out
    }
}

/// Monta `targets`: indice-fonte -> Option<indice na uniao>.
pub fn map_targets(
    file_headers: &[String],
    union_index: &HashMap<&str, usize>,
) -> Vec<Option<usize>> {
    file_headers
        .iter()
        .map(|h| union_index.get(h.as_str()).copied())
        .collect()
}

/// Inverso de `targets`: indice-uniao -> Option<indice-fonte>.
pub fn invert_targets(targets: &[Option<usize>], ncols: usize) -> Vec<Option<usize>> {
    let mut inv = vec![None; ncols];
    for (s, t) in targets.iter().enumerate() {
        if let Some(c) = t {
            if inv[*c].is_none() {
                inv[*c] = Some(s);
            }
        }
    }
    inv
}
