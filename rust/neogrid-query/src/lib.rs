//! Leitura da base SQLite do NeoGrid.
//! Espelha `electron/database.js: DatabaseManager` com JSON de resposta
//! identico (para o frontend nao perceber a troca).
//!
//! Sem cache de statements (prepare por chamada, ~µs — irrelevante perto do
//! IO); `Connection` e `Send`, para o shell expor via `Mutex<Manager>`.

#[cfg(test)]
mod testes_busca {
    use super::*;

    fn base_teste(pasta: &Path) -> PathBuf {
        let arquivo = pasta.join("base.sqlite");
        let _ = std::fs::remove_file(&arquivo);
        let conn = Connection::open(&arquivo).unwrap();
        let schema = serde_json::json!({
            "format": "neogrid-sqlite",
            "layers": [
                {"type": "poste", "count": 3, "headers": ["DE_BARRAMENTO"], "dicts": {}},
                {"type": "inst", "count": 2, "headers": ["DE_PLACA"], "dicts": {"DE_PLACA": ["", "T18120"]}},
            ],
        });
        conn.execute_batch(
            "CREATE TABLE meta (key TEXT, value TEXT);
             CREATE TABLE poste (_rid INTEGER PRIMARY KEY, _id TEXT, DE_BARRAMENTO TEXT, enchimento TEXT);
             CREATE TABLE inst (_rid INTEGER PRIMARY KEY, _id TEXT, DE_PLACA INTEGER, enchimento TEXT);
             INSERT INTO poste VALUES (1, '100', 'h044357', zeroblob(2000)), (2, '200', ' H044358 ', ''), (3, '300', '', '');
             INSERT INTO inst VALUES (1, '42666', 1, ''), (2, '42667', 0, '');",
        )
        .unwrap();
        conn.execute("INSERT INTO meta VALUES ('schema', ?)", [schema.to_string()]).unwrap();
        arquivo
    }

    #[test]
    fn busca_por_barramento_e_placa() {
        let pasta = std::env::temp_dir().join(format!("neogrid-busca-{}", std::process::id()));
        std::fs::create_dir_all(&pasta).unwrap();
        let base = base_teste(&pasta);
        let antes = std::fs::read(&base).unwrap();
        let indice = pasta.join(nome_indice_busca(&base).unwrap());
        let mgr = Manager::open(&base).unwrap();

        let aguardando = mgr.search_fields("H04", 10).unwrap();
        assert_eq!(aguardando["estado"], "preparando");
        assert_eq!(aguardando["hits"].as_array().unwrap().len(), 0);

        gerar_indice_busca(&base, &indice).unwrap();
        assert!(!indice.with_extension("tmp").exists(), "temporário removido");
        mgr.usar_indice_busca(&indice).unwrap();

        let r = mgr.search_fields("h0443", 10).unwrap();
        assert_eq!(r["estado"], "pronto");
        let hits = r["hits"].as_array().unwrap();
        assert_eq!(hits.len(), 2, "{r}");
        assert_eq!(hits[0]["valor"], "H044357");
        assert_eq!(hits[0]["id"], "100");
        assert_eq!(hits[0]["campo"], "barramento");
        assert_eq!(hits[1]["valor"], "H044358");

        // Coluna guardada em dicionário: procura o texto, nunca o código.
        let placa = mgr.search_fields("t18120", 10).unwrap();
        assert_eq!(placa["hits"][0]["type"], "inst");
        assert_eq!(placa["hits"][0]["id"], "42666");
        assert_eq!(placa["hits"].as_array().unwrap().len(), 1);

        assert_eq!(mgr.search_fields("ZZZ", 10).unwrap()["hits"].as_array().unwrap().len(), 0);

        // Quem digita o meio do código também acha: o índice completa por trecho.
        let meio = mgr.search_fields("4435", 10).unwrap();
        let hits = meio["hits"].as_array().unwrap();
        assert!(hits.iter().any(|h| h["valor"] == "H044357"), "{meio}");
        assert!(hits.iter().any(|h| h["valor"] == "H044358"), "{meio}");

        let exato = mgr.search_fields("h044357", 10).unwrap();
        assert_eq!(exato["hits"][0]["valor"], "H044357");
        drop(mgr);
        assert_eq!(std::fs::read(&base).unwrap(), antes, "a base não pode mudar");
        let _ = std::fs::remove_dir_all(&pasta);
    }
}

use rusqlite::{functions::FunctionFlags, types::Value, Connection, OpenFlags};
use serde::Serialize;
use std::cell::RefCell;
use std::collections::HashMap;
use std::io::Read;
use std::path::{Path, PathBuf};
use std::sync::Arc;

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
    /// Regionais selecionadas; vazio = todas. Filtra mapa e coleta por área.
    regions: RefCell<Vec<String>>,
    path: PathBuf,
    /// Índice de busca por campo (arquivo à parte) e como ele está.
    busca: RefCell<Option<Connection>>,
    busca_estado: RefCell<EstadoBusca>,
}

/// Situação do índice de busca por campo, informada à barra de pesquisa.
#[derive(Clone, Debug, PartialEq)]
pub enum EstadoBusca {
    Preparando,
    Pronto,
    Erro(String),
}

/// Campos pesquisáveis além do `_id`: (camada, nomes aceitos da coluna, rótulo).
/// A posição na lista é o código `fonte` gravado no índice: mudar a lista exige
/// subir `BUSCA_VERSAO`.
const BUSCA_CAMPOS: [(&str, &[&str], &str); 2] = [
    ("poste", &["DE_BARRAMENTO", "DE_BARRAMEN"], "barramento"),
    ("inst", &["DE_PLACA"], "placa"),
];
const BUSCA_VERSAO: u32 = 1;

fn normalizar_termo(texto: &str) -> String {
    texto.trim().to_uppercase()
}

fn fnv1a(dados: &[u8], mut hash: u64) -> u64 {
    for b in dados {
        hash ^= u64::from(*b);
        hash = hash.wrapping_mul(0x0000_0100_0000_01b3);
    }
    hash
}

/// Nome do arquivo de índice de uma base: muda quando a base é trocada ou regravada.
pub fn nome_indice_busca(base: &Path) -> Result<String, String> {
    let meta = std::fs::metadata(base).map_err(|e| format!("base: {e}"))?;
    let mtime = meta
        .modified()
        .ok()
        .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
        .map(|d| d.as_secs())
        .unwrap_or(0);
    let mut hash = 0xcbf2_9ce4_8422_2325;
    hash = fnv1a(base.to_string_lossy().as_bytes(), hash);
    hash = fnv1a(&meta.len().to_le_bytes(), hash);
    hash = fnv1a(&mtime.to_le_bytes(), hash);
    hash = fnv1a(&BUSCA_VERSAO.to_le_bytes(), hash);
    Ok(format!("busca-{hash:016x}.sqlite"))
}

/// Grava o índice de busca em `destino`, sem tocar na base: a base é aberta só para
/// leitura e o arquivo só recebe o nome final depois de completo.
pub fn gerar_indice_busca(base: &Path, destino: &Path) -> Result<(), String> {
    let origem = Manager::open(base)?;
    let temporario = destino.with_extension("tmp");
    let _ = std::fs::remove_file(&temporario);
    let resultado = origem.gravar_indice_busca(&temporario);
    match resultado.and_then(|()| std::fs::rename(&temporario, destino).map_err(|e| format!("gravar índice: {e}"))) {
        Ok(()) => Ok(()),
        Err(erro) => {
            let _ = std::fs::remove_file(&temporario);
            Err(erro)
        }
    }
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
        Ok(Self {
            conn,
            layers,
            info_json: schema,
            regions: RefCell::new(Vec::new()),
            path: path.to_path_buf(),
            busca: RefCell::new(None),
            busca_estado: RefCell::new(EstadoBusca::Preparando),
        })
    }

    pub fn info(&self) -> &serde_json::Value {
        &self.info_json
    }

    pub fn path(&self) -> &Path {
        &self.path
    }

    pub fn definir_estado_busca(&self, estado: EstadoBusca) {
        *self.busca_estado.borrow_mut() = estado;
    }

    /// Passa a pesquisar em um índice já completo.
    pub fn usar_indice_busca(&self, arquivo: &Path) -> Result<(), String> {
        let conn = Connection::open_with_flags(arquivo, OpenFlags::SQLITE_OPEN_READ_ONLY)
            .map_err(|e| format!("abrir índice: {e}"))?;
        conn.query_row("SELECT count(*) FROM (SELECT 1 FROM busca LIMIT 1)", [], |r| r.get::<_, i64>(0))
            .map_err(|e| format!("índice de busca inválido: {e}"))?;
        *self.busca.borrow_mut() = Some(conn);
        *self.busca_estado.borrow_mut() = EstadoBusca::Pronto;
        Ok(())
    }

    fn gravar_indice_busca(&self, arquivo: &Path) -> Result<(), String> {
        let saida = Connection::open(arquivo).map_err(|e| format!("criar índice: {e}"))?;
        saida
            .execute_batch(
                "PRAGMA journal_mode = OFF; PRAGMA synchronous = OFF; PRAGMA cache_size = -262144; PRAGMA temp_store = MEMORY;
                 CREATE TABLE busca (termo TEXT NOT NULL, fonte INTEGER NOT NULL, rid INTEGER NOT NULL,
                                     PRIMARY KEY (termo, fonte, rid)) WITHOUT ROWID;
                 BEGIN;",
            )
            .map_err(|e| format!("criar índice: {e}"))?;
        {
            let mut inserir = saida
                .prepare("INSERT OR IGNORE INTO busca (termo, fonte, rid) VALUES (?, ?, ?)")
                .map_err(|e| e.to_string())?;
            for (fonte, (camada, nomes, _)) in BUSCA_CAMPOS.iter().enumerate() {
                let Some(info) = self.layers.get(*camada) else { continue };
                let Some(coluna) = nomes.iter().find_map(|n| info.headers.iter().position(|h| h == n)) else { continue };
                let q = quote_ident(&info.headers[coluna]);
                let dicionario = info.dicts.get(&coluna);
                let sql = format!("SELECT \"_rid\", {q} FROM \"{camada}\" WHERE {q} IS NOT NULL AND {q} != ''");
                let mut ler = self.conn.prepare(&sql).map_err(|e| e.to_string())?;
                let mut linhas = ler.query([]).map_err(|e| e.to_string())?;
                while let Some(linha) = linhas.next().map_err(|e| e.to_string())? {
                    let rid: i64 = linha.get(0).map_err(|e| e.to_string())?;
                    let valor: Value = linha.get(1).map_err(|e| e.to_string())?;
                    let texto = match (&valor, dicionario) {
                        (Value::Integer(codigo), Some(lista)) => lista.get(*codigo as usize).cloned().unwrap_or_default(),
                        (Value::Integer(n), None) => n.to_string(),
                        (Value::Real(f), _) => float_cell(*f),
                        (Value::Text(s), _) => s.clone(),
                        _ => String::new(),
                    };
                    let termo = normalizar_termo(&texto);
                    if termo.is_empty() {
                        continue;
                    }
                    inserir
                        .execute(rusqlite::params![termo, fonte as i64, rid])
                        .map_err(|e| format!("gravar índice: {e}"))?;
                }
            }
        }
        saida.execute_batch("COMMIT;").map_err(|e| format!("gravar índice: {e}"))?;
        Ok(())
    }

    /// Procura o termo nos campos de `BUSCA_CAMPOS`, sem diferenciar maiúsculas.
    /// Valores iguais vêm primeiro, depois os que começam com o termo e, por
    /// último, os que o contêm no meio (ex.: `44357` acha `H044357`).
    pub fn search_fields(&self, term: &str, limit: i64) -> Result<serde_json::Value, String> {
        let estado = self.busca_estado.borrow().clone();
        let (nome_estado, erro) = match &estado {
            EstadoBusca::Preparando => ("preparando", None),
            EstadoBusca::Pronto => ("pronto", None),
            EstadoBusca::Erro(texto) => ("erro", Some(texto.clone())),
        };
        let pedido = limit.clamp(1, 200);
        let mut hits = Vec::new();
        let termo = normalizar_termo(term);

        // Lê o `_id` da linha e monta o resultado no formato que a busca da tela espera.
        let montar = |valor: String, fonte: i64, rid: i64| -> Result<serde_json::Value, String> {
            let Some((camada, _, campo)) = BUSCA_CAMPOS.get(fonte as usize) else {
                return Ok(serde_json::Value::Null);
            };
            let sql = format!("SELECT \"_id\" FROM \"{camada}\" WHERE \"_rid\" = ?");
            let id = self
                .query_tuples(&sql, &[&rid as &dyn rusqlite::ToSql])?
                .into_iter()
                .next()
                .and_then(|v| v.into_iter().next())
                .map(|v| match v {
                    Value::Text(s) => s,
                    Value::Integer(n) => n.to_string(),
                    Value::Real(f) => float_cell(f),
                    _ => String::new(),
                })
                .unwrap_or_default();
            Ok(serde_json::json!({"type": camada, "i": rid, "id": id, "valor": valor, "campo": campo}))
        };

        if let (Some(busca), false) = (self.busca.borrow().as_ref(), termo.is_empty()) {
            let fim = format!("{termo}\u{10FFFF}");
            let mut stmt = busca
                .prepare("SELECT termo, fonte, rid FROM busca WHERE termo >= ? AND termo < ? ORDER BY termo LIMIT ?")
                .map_err(|e| e.to_string())?;
            let achados = stmt
                .query_map(rusqlite::params![termo, fim, pedido], |r| {
                    Ok((r.get::<_, String>(0)?, r.get::<_, i64>(1)?, r.get::<_, i64>(2)?))
                })
                .map_err(|e| e.to_string())?
                .collect::<Result<Vec<_>, _>>()
                .map_err(|e| e.to_string())?;
            for (valor, fonte, rid) in achados {
                let hit = montar(valor, fonte, rid)?;
                if !hit.is_null() {
                    hits.push(hit);
                }
            }

            // O começo do valor não preencheu a lista: procura também no meio
            // (quem digita "44357" costuma não lembrar do prefixo "H0").
            if (hits.len() as i64) < pedido {
                let mut stmt = busca
                    .prepare(
                        "SELECT termo, fonte, rid FROM busca WHERE instr(termo, ?) > 0 \
                         ORDER BY length(termo), termo LIMIT ?",
                    )
                    .map_err(|e| e.to_string())?;
                let achados = stmt
                    .query_map(rusqlite::params![termo, pedido * 3], |r| {
                        Ok((r.get::<_, String>(0)?, r.get::<_, i64>(1)?, r.get::<_, i64>(2)?))
                    })
                    .map_err(|e| e.to_string())?
                    .collect::<Result<Vec<_>, _>>()
                    .map_err(|e| e.to_string())?;
                for (valor, fonte, rid) in achados {
                    if valor.starts_with(&termo) {
                        continue; // já veio na consulta por começo
                    }
                    let hit = montar(valor, fonte, rid)?;
                    if hit.is_null() {
                        continue;
                    }
                    hits.push(hit);
                    if hits.len() as i64 >= pedido {
                        break;
                    }
                }
            }
        }
        Ok(serde_json::json!({"estado": nome_estado, "erro": erro, "hits": hits}))
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
             WHERE r.\"max_lon\" >= ? AND r.\"min_lon\" <= ? AND r.\"max_lat\" >= ? AND r.\"min_lat\" <= ?{region}
             LIMIT ?",
            region = self.active_region_clause(layer_type)
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
        let region = self.active_region_clause(layer_type);
        let join = if region.is_empty() {
            String::new()
        } else {
            format!(" JOIN \"{layer_type}\" p ON p.\"_rid\" = r.\"id\"")
        };
        let sql = format!(
            "SELECT r.\"id\" FROM \"rtree_{layer_type}\" r{join}
             WHERE r.\"max_lon\" >= ? AND r.\"min_lon\" <= ? AND r.\"max_lat\" >= ? AND r.\"min_lat\" <= ?{region}
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

    // ---- regionais ----

    /// Regionais existentes na base (coluna `REGIONAL`), em ordem alfabética.
    pub fn regions(&self) -> Vec<String> {
        let mut out = Vec::new();
        for layer in self.layers.values() {
            if let Some(idx) = layer.headers.iter().position(|h| h == REGIONAL_HEADER) {
                if let Some(values) = layer.dicts.get(&idx) {
                    out.extend(values.iter().cloned());
                }
            }
        }
        out.sort();
        out.dedup();
        out
    }

    pub fn set_regions(&self, regions: Vec<String>) {
        *self.regions.borrow_mut() = regions;
    }

    pub fn selected_regions(&self) -> Vec<String> {
        self.regions.borrow().clone()
    }

    /// Trecho SQL (`AND p."REGIONAL" IN (...)`) para as regionais informadas.
    /// Uma regional inexistente na camada não casa nada, em vez de liberar tudo.
    fn region_clause(&self, layer_type: &str, regions: &[String]) -> String {
        if regions.is_empty() {
            return String::new();
        }
        let Some(layer) = self.layers.get(layer_type) else {
            return String::new();
        };
        let Some(idx) = layer.headers.iter().position(|h| h == REGIONAL_HEADER) else {
            return String::new();
        };
        let values: Vec<String> = match layer.dicts.get(&idx) {
            Some(dict) => regions
                .iter()
                .filter_map(|r| dict.iter().position(|v| v == r))
                .map(|code| code.to_string())
                .collect(),
            None => regions.iter().map(|r| format!("'{}'", r.replace('\'', "''"))).collect(),
        };
        if values.is_empty() {
            return " AND 0".to_string();
        }
        format!(" AND p.\"{REGIONAL_HEADER}\" IN ({})", values.join(","))
    }

    fn active_region_clause(&self, layer_type: &str) -> String {
        self.region_clause(layer_type, &self.regions.borrow())
    }

    // ---- leitura em lote para o módulo Projeto ----

    /// Linhas completas de uma área em formato compacto: `{h, rows, n, corte}`.
    /// A geometria descompactada volta na coluna `GEOMETRIA_WKT`.
    /// `regions = None` usa o filtro ativo do mapa.
    #[allow(clippy::too_many_arguments)]
    pub fn area(
        &self,
        layer_type: &str,
        west: f64,
        east: f64,
        south: f64,
        north: f64,
        limit: i64,
        regions: Option<&[String]>,
    ) -> Result<serde_json::Value, String> {
        let layer = self.layer(layer_type)?;
        let mut headers = layer.headers.clone();
        let wkt = match headers.iter().position(|h| h == WKT_HEADER) {
            Some(i) => i,
            None => {
                headers.push(WKT_HEADER.to_string());
                headers.len() - 1
            }
        };
        let columns = self.select_columns(layer_type)?.replace(", \"", ", p.\"");
        let safe = limit.clamp(1, 6_000_000);
        let fetch = safe + 1;
        let region = match regions {
            Some(list) => self.region_clause(layer_type, list),
            None => self.active_region_clause(layer_type),
        };
        let sql = format!(
            "SELECT p.\"_rid\", p.\"_geom\", p.\"_min_lon\", p.\"_max_lon\", p.\"_min_lat\", p.\"_max_lat\"{columns}
             FROM \"rtree_{layer_type}\" r JOIN \"{layer_type}\" p ON p.\"_rid\" = r.\"id\"
             WHERE r.\"max_lon\" >= ? AND r.\"min_lon\" <= ? AND r.\"max_lat\" >= ? AND r.\"min_lat\" <= ?{region}
             LIMIT ?"
        );
        let mut packets = self.query_rows(layer_type, &sql, &[&west, &east, &south, &north, &fetch])?;
        let corte = packets.len() as i64 > safe;
        packets.truncate(safe as usize);
        let n = packets.len();
        let rows: Vec<Vec<String>> = packets
            .into_iter()
            .map(|packet| {
                let mut row = packet.row;
                row.resize(headers.len(), String::new());
                if !packet.geom.is_empty() {
                    row[wkt] = packet.geom;
                }
                row
            })
            .collect();
        Ok(serde_json::json!({"h": headers, "rows": rows, "n": n, "corte": corte}))
    }

    /// Contexto para consultas SQL fora do lock do banco principal.
    pub fn sql_context(&self) -> SqlContext {
        let mut layers: Vec<(String, Vec<String>, HashMap<usize, Vec<String>>)> = self
            .layers
            .iter()
            .map(|(name, l)| (name.clone(), l.headers.clone(), l.dicts.clone()))
            .collect();
        layers.sort_by(|a, b| a.0.cmp(&b.0));
        SqlContext { path: self.path.clone(), layers: Arc::new(layers) }
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

const REGIONAL_HEADER: &str = "REGIONAL";
const WKT_HEADER: &str = "GEOMETRIA_WKT";
const SQL_TIMEOUT_SECS: u64 = 60;

/// Consulta SQL do usuário: conexão própria, somente leitura, com visões
/// `v_<camada>` que já devolvem os valores dos dicionários e o WKT.
#[derive(Clone)]
pub struct SqlContext {
    path: PathBuf,
    layers: Arc<Vec<(String, Vec<String>, HashMap<usize, Vec<String>>)>>,
}

/// Há `;` fora de texto, identificador entre aspas ou comentário?
fn has_statement_separator(sql: &str) -> bool {
    let bytes = sql.as_bytes();
    let mut i = 0;
    while i < bytes.len() {
        match bytes[i] {
            quote @ (b'\'' | b'"' | b'`') => {
                i += 1;
                while i < bytes.len() && bytes[i] != quote {
                    i += 1;
                }
            }
            b'[' => {
                while i < bytes.len() && bytes[i] != b']' {
                    i += 1;
                }
            }
            b'-' if bytes.get(i + 1) == Some(&b'-') => {
                while i < bytes.len() && bytes[i] != b'\n' {
                    i += 1;
                }
            }
            b'/' if bytes.get(i + 1) == Some(&b'*') => {
                i += 2;
                while i + 1 < bytes.len() && !(bytes[i] == b'*' && bytes[i + 1] == b'/') {
                    i += 1;
                }
                i += 1;
            }
            b';' => return true,
            _ => {}
        }
        i += 1;
    }
    false
}

#[cfg(test)]
mod tests {
    use super::has_statement_separator;

    #[test]
    fn separador_so_conta_fora_de_texto_e_comentario() {
        assert!(has_statement_separator("select 1; drop table poste"));
        assert!(!has_statement_separator("select ';' from poste"));
        assert!(!has_statement_separator("select \"a;b\" from poste -- fim;\n"));
        assert!(!has_statement_separator("select 1 /* ; */ + 2"));
        assert!(!has_statement_separator("select [a;b] from poste"));
    }
}

fn inflate_geom(value: &Value) -> Option<String> {
    match value {
        Value::Text(s) => Some(s.clone()),
        Value::Blob(b) => {
            let mut dec = flate2::read::ZlibDecoder::new(&b[..]);
            let mut s = String::new();
            dec.read_to_string(&mut s).ok().map(|_| s)
        }
        _ => None,
    }
}

impl SqlContext {
    fn open(&self) -> Result<Connection, String> {
        let conn = Connection::open_with_flags(&self.path, OpenFlags::SQLITE_OPEN_READ_ONLY)
            .map_err(|e| format!("abrir banco: {e}"))?;
        conn.execute_batch("PRAGMA temp_store = MEMORY; PRAGMA cache_size = -65536;")
            .map_err(|e| e.to_string())?;
        let layers = self.layers.clone();
        conn.create_scalar_function(
            "ng_dict",
            3,
            FunctionFlags::SQLITE_UTF8 | FunctionFlags::SQLITE_DETERMINISTIC,
            move |ctx| {
                let layer: usize = ctx.get(0)?;
                let column: usize = ctx.get(1)?;
                Ok(match ctx.get_raw(2).as_i64() {
                    Ok(code) => layers
                        .get(layer)
                        .and_then(|l| l.2.get(&column))
                        .and_then(|dict| dict.get(code as usize))
                        .cloned(),
                    Err(_) => ctx.get_raw(2).as_str().ok().map(str::to_string),
                })
            },
        )
        .map_err(|e| e.to_string())?;
        conn.create_scalar_function(
            "ng_wkt",
            1,
            FunctionFlags::SQLITE_UTF8 | FunctionFlags::SQLITE_DETERMINISTIC,
            |ctx| Ok(inflate_geom(&ctx.get::<Value>(0)?)),
        )
        .map_err(|e| e.to_string())?;
        for (l, (name, headers, dicts)) in self.layers.iter().enumerate() {
            let columns: Vec<String> = headers
                .iter()
                .enumerate()
                .map(|(c, h)| {
                    let q = quote_ident(h);
                    if h == WKT_HEADER {
                        format!("ng_wkt(\"_geom\") AS {q}")
                    } else if dicts.contains_key(&c) {
                        format!("ng_dict({l}, {c}, {q}) AS {q}")
                    } else {
                        q
                    }
                })
                .collect();
            conn.execute_batch(&format!(
                "CREATE TEMP VIEW \"v_{name}\" AS SELECT \"_rid\" AS \"ID_INTERNO\", {} FROM main.\"{name}\";",
                columns.join(", ")
            ))
            .map_err(|e| e.to_string())?;
        }
        conn.execute_batch("PRAGMA query_only = ON;").map_err(|e| e.to_string())?;
        Ok(conn)
    }

    /// Executa um único SELECT. Retorna `{cols, rows, corte}`.
    pub fn run(&self, query: &str, max: usize) -> Result<serde_json::Value, String> {
        let text = query.trim().trim_end_matches(|c: char| c == ';' || c.is_whitespace());
        let low = text.to_lowercase();
        let allowed = ["select", "with", "explain", "pragma table_info"];
        if !allowed.iter().any(|p| low.starts_with(p)) {
            return Err("Apenas consultas SELECT são permitidas.".to_string());
        }
        if has_statement_separator(text) {
            return Err("Envie uma consulta por vez.".to_string());
        }
        let conn = self.open()?;
        let started = std::time::Instant::now();
        conn.progress_handler(
            20_000,
            Some(move || started.elapsed().as_secs() >= SQL_TIMEOUT_SECS),
        );
        let mut stmt = conn.prepare(text).map_err(|e| e.to_string())?;
        if !stmt.readonly() {
            return Err("Apenas consultas somente leitura são permitidas.".to_string());
        }
        let cols: Vec<String> = stmt.column_names().iter().map(|c| c.to_string()).collect();
        let ncol = cols.len();
        let limit = max.clamp(1, 20_000);
        let mut rows = stmt.query([]).map_err(|e| e.to_string())?;
        let mut out: Vec<Vec<serde_json::Value>> = Vec::new();
        let mut corte = false;
        while let Some(row) = rows.next().map_err(|e| {
            if started.elapsed().as_secs() >= SQL_TIMEOUT_SECS {
                format!("Consulta interrompida: passou de {SQL_TIMEOUT_SECS} segundos.")
            } else {
                e.to_string()
            }
        })? {
            if out.len() >= limit {
                corte = true;
                break;
            }
            let mut values = Vec::with_capacity(ncol);
            for i in 0..ncol {
                values.push(match row.get::<_, Value>(i).map_err(|e| e.to_string())? {
                    Value::Null => serde_json::Value::Null,
                    Value::Integer(v) => serde_json::json!(v),
                    Value::Real(v) => serde_json::json!(v),
                    Value::Text(v) => serde_json::json!(v),
                    Value::Blob(v) => serde_json::json!(format!("(binário, {} bytes)", v.len())),
                });
            }
            out.push(values);
        }
        Ok(serde_json::json!({"cols": cols, "rows": out, "corte": corte}))
    }
}

/// Formata REAL como o JS faria em `String(numero)`: repr mais curta
/// (Ryū aqui, igual ao algoritmo do JSON.stringify para a comparacao).
fn float_cell(f: f64) -> String {
    serde_json::Number::from_f64(f)
        .map(|n| n.to_string())
        .unwrap_or_default()
}
