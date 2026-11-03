//! Leitura da base SQLite do NeoGrid.
//! Espelha `electron/database.js: DatabaseManager` com JSON de resposta
//! identico (para o frontend nao perceber a troca).
//!
//! Sem cache de statements (prepare por chamada, ~µs — irrelevante perto do
//! IO); `Connection` e `Send`, para o shell expor via `Mutex<Manager>`.

use rusqlite::{types::Value, Connection, OpenFlags};
use serde::Serialize;
use std::collections::HashMap;
use std::io::Read;
use std::path::Path;

/// Pacote de linha, mesma forma do `toRow` do JS: `{i, row, geom, b}`.
#[derive(Serialize, Clone, Debug, PartialEq)]
pub struct Packet {
    pub i: i64,
    pub row: Vec<String>,
    pub geom: String,
    pub b: [Option<f64>; 4],
}

#[derive(Clone, Debug)]
struct LayerInfo {
    headers: Vec<String>,
    count: i64,
    /// indice-da-coluna -> dicionario (na ordem do schema).
    dicts: HashMap<usize, Vec<String>>,
}

pub struct Manager {
    conn: Connection,
    layers: HashMap<String, LayerInfo>,
    /// `info` no formato do `db:info` (o schema + path/size/mtime).
    info_json: serde_json::Value,
}

fn sql_value_f64(v: &Value) -> Option<f64> {
    match v {
        Value::Real(f) => Some(*f),
        Value::Integer(i) => Some(*i as f64),
        _ => None,
    }
}

fn escape_like(text: &str) -> String {
    let mut out = String::with_capacity(text.len());
    for c in text.chars() {
        if c == '\\' || c == '%' || c == '_' {
            out.push('\\');
        }
        out.push(c);
    }
    out
}

fn quote_ident(name: &str) -> String {
    format!("\"{}\"", name.replace('"', "\"\""))
}

impl Manager {
    pub fn open(path: &Path) -> Result<Self, String> {
        let ext = path
            .extension()
            .and_then(|e| e.to_str())
            .map(|e| e.to_lowercase())
            .unwrap_or_default();
        if !["sqlite", "sqlite3", "db"].contains(&ext.as_str()) {
            return Err("Selecione um banco SQLite (.sqlite, .sqlite3 ou .db).".to_string());
        }
        let meta = std::fs::metadata(path).map_err(|_| "Banco de dados não encontrado.".to_string())?;
        if !meta.is_file() || meta.len() < 1024 {
            return Err("Arquivo de banco inválido.".to_string());
        }
        let conn = Connection::open_with_flags(path, OpenFlags::SQLITE_OPEN_READ_ONLY)
            .map_err(|e| format!("abrir banco: {e}"))?;
        conn.execute_batch("PRAGMA query_only = ON; PRAGMA cache_size = -131072; PRAGMA temp_store = MEMORY;")
            .map_err(|e| format!("pragmas: {e}"))?;
        let schema_text: String = conn
            .query_row("SELECT value FROM meta WHERE key = 'schema'", [], |r| r.get(0))
            .map_err(|_| "Este banco não foi gerado pelo NeoGrid (metadados ausentes).".to_string())?;
        let mut schema: serde_json::Value =
            serde_json::from_str(&schema_text).map_err(|_| "Formato de banco não reconhecido.".to_string())?;
        let layers_arr = schema
            .get("layers")
            .and_then(|v| v.as_array())
            .ok_or("Formato de banco não reconhecido.")?
            .clone();
        if layers_arr.is_empty() {
            return Err("O banco não contém camadas do NeoGrid.".to_string());
        }
        if schema.get("format").and_then(|v| v.as_str()) != Some("neogrid-sqlite") {
            return Err("Formato de banco não reconhecido.".to_string());
        }
        let mut layers = HashMap::new();
        for layer in &layers_arr {
            let t = layer.get("type").and_then(|v| v.as_str()).unwrap_or("").to_string();
            if t.is_empty() {
                continue;
            }
            let headers: Vec<String> = layer
                .get("headers")
                .and_then(|v| v.as_array())
                .map(|a| a.iter().filter_map(|v| v.as_str().map(|s| s.to_string())).collect())
                .unwrap_or_default();
            if headers.is_empty() {
                continue;
            }
            let mut dicts = HashMap::new();
            if let Some(obj) = layer.get("dicts").and_then(|v| v.as_object()) {
                for (header, list) in obj {
                    if let Some(idx) = headers.iter().position(|h| h == header) {
                        let values: Vec<String> = list
                            .as_array()
                            .map(|a| a.iter().map(|v| v.as_str().unwrap_or("").to_string()).collect())
                            .unwrap_or_default();
                        dicts.insert(idx, values);
                    }
                }
            }
            layers.insert(
                t,
                LayerInfo {
                    headers,
                    count: layer.get("count").and_then(|v| v.as_i64()).unwrap_or(0),
                    dicts,
                },
            );
        }
        if layers.is_empty() {
            return Err("O banco não contém camadas do NeoGrid.".to_string());
        }
        schema["path"] = serde_json::Value::String(path.to_string_lossy().to_string());
        schema["size"] = serde_json::json!(meta.len());
        Ok(Self { conn: conn, layers, info_json: schema })
    }

    pub fn info(&self) -> &serde_json::Value {
        &self.info_json
    }

    fn layer(&self, layer_type: &str) -> Result<&LayerInfo, String> {
        self.layers
            .get(layer_type)
            .ok_or_else(|| format!("Camada inválida: {layer_type}"))
    }

    fn select_columns(&self, layer_type: &str) -> Result<String, String> {
        let layer = self.layer(layer_type)?;
        if layer.headers.is_empty() {
            return Ok(String::new());
        }
        Ok(format!(
            ", {}",
            layer.headers.iter().map(|h| quote_ident(h)).collect::<Vec<_>>().join(", ")
        ))
    }

    fn to_row(&self, layer_type: &str, values: Vec<Value>) -> Result<Packet, String> {
        let layer = self.layer(layer_type)?;
        if values.len() < 6 {
            return Err("linha curta".to_string());
        }
        let rid = match &values[0] {
            Value::Integer(i) => *i,
            _ => return Err("rid inválido".to_string()),
        };
        let geom = match &values[1] {
            Value::Null => String::new(),
            Value::Text(s) => s.clone(),
            Value::Blob(b) => {
                let mut dec = flate2::read::ZlibDecoder::new(&b[..]);
                let mut s = String::new();
                match dec.read_to_string(&mut s) {
                    Ok(_) => s,
                    Err(_) => String::new(),
                }
            }
            _ => String::new(),
        };
        let b = [
            sql_value_f64(&values[2]),
            sql_value_f64(&values[3]),
            sql_value_f64(&values[4]),
            sql_value_f64(&values[5]),
        ];
        let mut row: Vec<String> = Vec::with_capacity(values.len().saturating_sub(6));
        for (i, v) in values.iter().skip(6).enumerate() {
            if let Some(list) = layer.dicts.get(&i) {
                match v {
                    Value::Integer(code) => {
                        row.push(list.get(*code as usize).cloned().unwrap_or_default())
                    }
                    Value::Null => row.push(String::new()),
                    Value::Text(s) => row.push(s.clone()),
                    _ => row.push(String::new()),
                }
            } else {
                match v {
                    Value::Null => row.push(String::new()),
                    Value::Text(s) => row.push(s.clone()),
                    Value::Integer(n) => row.push(n.to_string()),
                    Value::Real(f) => row.push(float_cell(*f)),
                    Value::Blob(_) => row.push(String::new()),
                }
            }
        }
        Ok(Packet { i: rid, row, geom, b })
    }

    fn query_rows(&self, layer_type: &str, sql: &str, params: &[&dyn rusqlite::ToSql]) -> Result<Vec<Packet>, String> {
        let mut stmt = self.conn.prepare(sql).map_err(|e| e.to_string())?;
        let ncol = stmt.column_count();
        let rows = stmt
            .query_map(rusqlite::params_from_iter(params.iter().copied()), |r| {
                let mut vals = Vec::with_capacity(ncol);
                for i in 0..ncol {
                    vals.push(r.get::<_, Value>(i)?);
                }
                Ok(vals)
            })
            .map_err(|e| e.to_string())?;
        let mut out = Vec::new();
        for row in rows {
            out.push(self.to_row(layer_type, row.map_err(|e| e.to_string())?)?);
        }
        Ok(out)
    }

    fn query_tuples(&self, sql: &str, params: &[&dyn rusqlite::ToSql]) -> Result<Vec<Vec<Value>>, String> {
        let mut stmt = self.conn.prepare(sql).map_err(|e| e.to_string())?;
        let ncol = stmt.column_count();
        let rows = stmt
            .query_map(rusqlite::params_from_iter(params.iter().copied()), |r| {
                let mut vals = Vec::with_capacity(ncol);
                for i in 0..ncol {
                    vals.push(r.get::<_, Value>(i)?);
                }
                Ok(vals)
            })
            .map_err(|e| e.to_string())?;
        rows.collect::<Result<Vec<_>, _>>().map_err(|e| e.to_string())
    }

    // ---- consultas (espelham database.js 1:1) ----

    pub fn viewport(
        &self,
        layer_type: &str,
        west: f64,
        east: f64,
        south: f64,
        north: f64,
        limit: i64,
    ) -> Result<Vec<Packet>, String> {
        let columns = self.select_columns(layer_type)?;
        let cols_prefixed = columns.replace(", \"", ", p.\"");
        let safe = limit.clamp(1, 20000);
        let sql = format!(
            "SELECT p.\"_rid\", p.\"_geom\", p.\"_min_lon\", p.\"_max_lon\", p.\"_min_lat\", p.\"_max_lat\"{cols_prefixed}
             FROM \"rtree_{layer_type}\" r JOIN \"{layer_type}\" p ON p.\"_rid\" = r.\"id\"
             WHERE r.\"max_lon\" >= ? AND r.\"min_lon\" <= ? AND r.\"max_lat\" >= ? AND r.\"min_lat\" <= ?
             LIMIT ?"
        );
        self.query_rows(layer_type, &sql, &[&west, &east, &south, &north, &safe])
    }

    pub fn rows(&self, layer_type: &str, ids: &[i64]) -> Result<Vec<Packet>, String> {
        let layer = self.layer(layer_type)?.clone();
        let columns = self.select_columns(layer_type)?;
        let mut out = Vec::new();
        for chunk in ids.chunks(8000) {
            let valid: Vec<i64> = chunk.iter().copied().filter(|v| *v >= 0 && *v < layer.count).collect();
            if valid.is_empty() {
                continue;
            }
            let placeholders = vec!["?"; valid.len()].join(",");
            let sql = format!(
                "SELECT \"_rid\", \"_geom\", \"_min_lon\", \"_max_lon\", \"_min_lat\", \"_max_lat\"{columns} FROM \"{layer_type}\" WHERE \"_rid\" IN ({placeholders})"
            );
            let refs: Vec<&dyn rusqlite::ToSql> = valid.iter().map(|v| v as &dyn rusqlite::ToSql).collect();
            out.extend(self.query_rows(layer_type, &sql, &refs)?);
        }
        Ok(out)
    }

    pub fn row(&self, layer_type: &str, id: i64) -> Result<Option<Packet>, String> {
        let layer = self.layer(layer_type)?.clone();
        if id < 0 || id >= layer.count {
            return Ok(None);
        }
        let columns = self.select_columns(layer_type)?;
        let sql = format!(
            "SELECT \"_rid\", \"_geom\", \"_min_lon\", \"_max_lon\", \"_min_lat\", \"_max_lat\"{columns} FROM \"{layer_type}\" WHERE \"_rid\" = ?"
        );
        let mut result = self.query_rows(layer_type, &sql, &[&id])?;
        Ok(result.pop())
    }

    pub fn index_bounds(&self, layer_type: &str) -> Result<serde_json::Value, String> {
        // `layers` e um ARRAY no schema; acha por tipo (como o JS via Map).
        Ok(self
            .layer_object(layer_type)
            .and_then(|l| l.get("bounds").cloned())
            .filter(|b| !b.is_null())
            .unwrap_or(serde_json::Value::Null))
    }

    fn layer_object(&self, layer_type: &str) -> Option<serde_json::Value> {
        self.info_json
            .get("layers")
            .and_then(|v| v.as_array())
            .and_then(|arr| {
                arr.iter()
                    .find(|l| l.get("type").and_then(|v| v.as_str()) == Some(layer_type))
                    .cloned()
            })
    }

    /// Hotspots como no JS — mas atenção: o schema guarda `{cx, cy, count}`;
    /// o JS retorna os objetos crus. Espelhado aqui.
    pub fn hotspots(&self, layer_type: &str, limit: i64) -> Result<serde_json::Value, String> {
        let safe = limit.clamp(1, 400) as usize;
        let spots = self
            .layer_object(layer_type)
            .and_then(|l| l.get("hotspots").cloned())
            .and_then(|v| match v {
                serde_json::Value::Array(a) => Some(a),
                _ => None,
            })
            .unwrap_or_default();
        Ok(serde_json::Value::Array(spots.into_iter().take(safe).collect()))
    }

    pub fn ids_in_bounds(
        &self,
        layer_type: &str,
        west: f64,
        east: f64,
        south: f64,
        north: f64,
        limit: i64,
    ) -> Result<Vec<i64>, String> {
        let safe = limit.clamp(1, 1000000);
        let sql = format!(
            "SELECT r.\"id\" FROM \"rtree_{layer_type}\" r
             WHERE r.\"max_lon\" >= ? AND r.\"min_lon\" <= ? AND r.\"max_lat\" >= ? AND r.\"min_lat\" <= ?
             LIMIT ?"
        );
        Ok(self
            .query_tuples(&sql, &[&west, &east, &south, &north, &safe])?
            .into_iter()
            .filter_map(|v| match v.into_iter().next() {
                Some(Value::Integer(i)) => Some(i),
                _ => None,
            })
            .collect())
    }

    pub fn search(&self, layer_type: &str, term: &str, limit: i64) -> Result<Vec<serde_json::Value>, String> {
        self.layer(layer_type)?;
        let text = term.trim();
        if text.is_empty() {
            return Ok(Vec::new());
        }
        let safe = limit.clamp(1, 200);
        let escaped = escape_like(text);
        let like = format!("{escaped}%");
        let sql = format!(
            "SELECT \"_rid\", \"_id\" FROM \"{layer_type}\" WHERE \"_id\" LIKE ? ESCAPE '\\' ORDER BY length(\"_id\"), \"_id\" LIMIT ?"
        );
        Ok(self
            .query_tuples(&sql, &[&like as &dyn rusqlite::ToSql, &safe])?
            .into_iter()
            .map(|v| {
                let rid = match v.first() {
                    Some(Value::Integer(i)) => *i,
                    _ => 0,
                };
                let id = match v.get(1) {
                    Some(Value::Text(s)) => s.clone(),
                    Some(Value::Integer(n)) => n.to_string(),
                    Some(Value::Real(f)) => float_cell(*f),
                    Some(Value::Null) | None => String::new(),
                    Some(Value::Blob(_)) => String::new(),
                };
                serde_json::json!({"i": rid, "id": id})
            })
            .collect())
    }

    pub fn find_by_id(&self, layer_type: &str, id: &str) -> Result<Option<i64>, String> {
        self.layer(layer_type)?;
        let text = id.trim();
        if text.is_empty() {
            return Ok(None);
        }
        let sql = format!("SELECT \"_rid\" FROM \"{layer_type}\" WHERE \"_id\" = ? LIMIT 1");
        let rows = self.query_tuples(&sql, &[&text as &dyn rusqlite::ToSql])?;
        Ok(rows.into_iter().next().and_then(|mut v| match v.pop() {
            Some(Value::Integer(i)) => Some(i),
            _ => None,
        }))
    }

    fn search_where(&self, layer_type: &str) -> Result<(String, usize), String> {
        let layer = self.layer(layer_type)?.clone();
        let preferred = |h: &str| {
            ["NU_", "DE_", "TIPO", "MATERIAL", "CONDUTOR", "CD_FASE", "FASE", "SE", "ALIM", "UTD", "POSSE", "TRAJETO", "NATUREZA", "KVA_TOTAL", "ESTADO", "SITUACAO"]
                .iter()
                .any(|p| h.starts_with(p))
                && !h.ends_with("_DESC")
                && h != "GEOMETRIA_WKT"
        };
        let mut cols: Vec<String> = layer.headers.iter().filter(|h| preferred(h)).cloned().collect();
        if cols.is_empty() {
            cols.push("_id".to_string());
        }
        let fragment = cols
            .iter()
            .map(|h| {
                let q = if h == "_id" { "\"_id\"".to_string() } else { quote_ident(h) };
                format!("{q} LIKE ? ESCAPE '\\'")
            })
            .collect::<Vec<_>>()
            .join(" OR ");
        Ok((format!(" WHERE ({fragment})"), cols.len()))
    }

    pub fn distinct(&self, layer_type: &str, field: &str, limit: i64) -> Result<Vec<String>, String> {
        let layer = self.layer(layer_type)?.clone();
        let name = field.trim().to_uppercase();
        if name.is_empty() || !layer.headers.contains(&name) {
            return Ok(Vec::new());
        }
        let safe = limit.clamp(1, 500);
        let q = quote_ident(&name);
        let sql = format!(
            "SELECT {q} AS v, COUNT(*) AS c FROM \"{layer_type}\" WHERE {q} IS NOT NULL AND {q} != '' GROUP BY v ORDER BY c DESC LIMIT ?"
        );
        // Espelha o JS: `([value]) => value == null ? '' : String(value)` —
        // o primeiro elemento e o valor (o segundo e a contagem).
        Ok(self
            .query_tuples(&sql, &[&safe])?
            .into_iter()
            .map(|v| match v.into_iter().next() {
                Some(Value::Text(s)) => s,
                Some(Value::Integer(n)) => n.to_string(),
                Some(Value::Real(f)) => float_cell(f),
                _ => String::new(),
            })
            .collect::<Vec<_>>())
    }

    pub fn links_for_pole(&self, pole: &str) -> Result<serde_json::Value, String> {
        let key = pole.trim();
        if key.is_empty() {
            return Ok(serde_json::json!({"inst": [], "nets": []}));
        }
        let inst: Vec<i64> = self
            .query_tuples("SELECT \"inst_rid\" FROM \"_link_pole_inst\" WHERE \"pole\" = ? LIMIT 200", &[&key as &dyn rusqlite::ToSql])?
            .into_iter()
            .filter_map(|mut v| match v.pop() {
                Some(Value::Integer(i)) => Some(i),
                _ => None,
            })
            .collect();
        let nets: Vec<serde_json::Value> = self
            .query_tuples("SELECT \"layer\", \"net_rid\" FROM \"_link_pole_net\" WHERE \"pole\" = ? LIMIT 200", &[&key as &dyn rusqlite::ToSql])?
            .into_iter()
            .map(|v| {
                let layer = match v.first() {
                    Some(Value::Text(s)) => s.clone(),
                    _ => String::new(),
                };
                let rid = match v.get(1) {
                    Some(Value::Integer(i)) => *i,
                    _ => 0,
                };
                serde_json::json!({"layer": layer, "rid": rid})
            })
            .collect();
        Ok(serde_json::json!({"inst": inst, "nets": nets}))
    }

    pub fn page(
        &self,
        layer_type: &str,
        offset: i64,
        limit: i64,
        search: &str,
        sort: Option<&str>,
        dir: i64,
    ) -> Result<serde_json::Value, String> {
        let layer = self.layer(layer_type)?.clone();
        let text = search.trim();
        let (where_clause, count) = if text.is_empty() {
            (String::new(), 0)
        } else {
            self.search_where(layer_type)?
        };
        let escaped = escape_like(text);
        let like = format!("%{escaped}%");
        // total
        let count_sql = format!("SELECT COUNT(*) FROM \"{layer_type}\"{where_clause}");
        let like_refs: Vec<&dyn rusqlite::ToSql> = (0..count).map(|_| &like as &dyn rusqlite::ToSql).collect();
        let total: i64 = {
            let mut stmt = self.conn.prepare(&count_sql).map_err(|e| e.to_string())?;
            stmt.query_row(rusqlite::params_from_iter(like_refs.iter().copied()), |r| r.get(0))
                .map_err(|e| e.to_string())?
        };
        let order = match sort {
            Some(s) if layer.headers.contains(&s.to_string()) => {
                format!("{} {}", quote_ident(s), if dir < 0 { "DESC" } else { "ASC" })
            }
            _ => "\"_rid\"".to_string(),
        };
        let offset_safe = offset.max(0);
        let limit_safe = limit.clamp(1, 1000);
        let columns = self.select_columns(layer_type)?;
        let sql = format!(
            "SELECT \"_rid\", \"_geom\", \"_min_lon\", \"_max_lon\", \"_min_lat\", \"_max_lat\"{columns} FROM \"{layer_type}\"{where_clause} ORDER BY {order} LIMIT ? OFFSET ?"
        );
        let mut refs: Vec<&dyn rusqlite::ToSql> = (0..count).map(|_| &like as &dyn rusqlite::ToSql).collect();
        refs.push(&limit_safe);
        refs.push(&offset_safe);
        let rows = self.query_rows(layer_type, &sql, &refs)?;
        Ok(serde_json::json!({
            "total": total,
            "offset": offset_safe,
            "limit": limit_safe,
            "rows": rows,
        }))
    }
}

/// Formata REAL como o JS faria em `String(numero)`: repr mais curta
/// (Ryū aqui, igual ao algoritmo do JSON.stringify para a comparacao).
fn float_cell(f: f64) -> String {
    serde_json::Number::from_f64(f)
        .map(|n| n.to_string())
        .unwrap_or_default()
}
