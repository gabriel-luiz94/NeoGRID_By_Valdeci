//! Suite de paridade do read path: roda consultas fixas e adaptativas sobre
//! um banco e imprime JSON canonico em stdout.
//! O script `parity/query-parity.js` roda a mesma suite via `database.js`.

use neogrid_query::Manager;
use std::path::PathBuf;

fn main() {
    let db = std::env::args()
        .nth(1)
        .expect("uso: neogrid-query-parity <banco.sqlite>");
    let mgr = Manager::open(&PathBuf::from(&db)).expect("abrir banco");
    let info = mgr.info();
    let layers: Vec<String> = info
        .get("layers")
        .and_then(|v| v.as_array())
        .map(|a| {
            a.iter()
                .filter_map(|l| l.get("type").and_then(|v| v.as_str()).map(|s| s.to_string()))
                .collect()
        })
        .unwrap_or_default();

    let mut suite = serde_json::Map::new();
    suite.insert(
        "layers".to_string(),
        serde_json::json!(layers.iter().map(|t| {
            let l = info.get("layers").and_then(|v| v.as_array()).unwrap()
                .iter().find(|x| x.get("type").and_then(|v| v.as_str()) == Some(t)).unwrap();
            serde_json::json!({"type": t, "count": l.get("count"), "headers": l.get("headers").map(|h| h.as_array().map(|a| a.len()))})
        }).collect::<Vec<_>>()),
    );

    // Centro da camada poste (garante viewport nao-vazia quando ha dados).
    let poste = info
        .get("layers")
        .and_then(|v| v.as_array())
        .and_then(|a| a.iter().find(|x| x.get("type").and_then(|v| v.as_str()) == Some("poste")))
        .cloned()
        .unwrap();
    let bounds = poste.get("bounds").cloned().unwrap_or(serde_json::Value::Null);
    let cx = bounds.get("west").and_then(|v| v.as_f64()).unwrap_or(-35.0);
    let ex = bounds.get("east").and_then(|v| v.as_f64()).unwrap_or(-34.0);
    let sy = bounds.get("south").and_then(|v| v.as_f64()).unwrap_or(-8.5);
    let ny = bounds.get("north").and_then(|v| v.as_f64()).unwrap_or(-7.5);
    let (w, e, s, n) = ((cx + ex) / 2.0 - 0.02, (cx + ex) / 2.0 + 0.02, (sy + ny) / 2.0 - 0.02, (sy + ny) / 2.0 + 0.02);

    suite.insert("viewport_poste".to_string(), serde_json::to_value(mgr.viewport("poste", w, e, s, n, 100).unwrap()).unwrap());
    suite.insert("ids_in_bounds".to_string(), serde_json::to_value(mgr.ids_in_bounds("poste", w, e, s, n, 1000).unwrap()).unwrap());
    suite.insert("row0".to_string(), serde_json::to_value(mgr.row("poste", 0).unwrap()).unwrap());
    suite.insert("rows_0_49".to_string(), serde_json::to_value(mgr.rows("poste", &(0..50).collect::<Vec<_>>()).unwrap()).unwrap());
    suite.insert("search_101".to_string(), serde_json::to_value(mgr.search("poste", "101", 5).unwrap()).unwrap());
    suite.insert("page_plain".to_string(), mgr.page("poste", 0, 5, "", None, 1).unwrap());

    // Derivadas da row0 (mesma derivacao no lado JS).
    let row0 = mgr.row("poste", 0).unwrap().expect("row0");
    let pole_idx = poste.get("indexes").and_then(|v| v.get("pole")).and_then(|v| v.as_i64()).unwrap_or(-1);
    let id_idx = poste.get("indexes").and_then(|v| v.get("id")).and_then(|v| v.as_i64()).unwrap_or(-1);
    let pole = if pole_idx >= 0 { row0.row.get(pole_idx as usize).cloned().unwrap_or_default() } else { String::new() };
    let the_id = if id_idx >= 0 { row0.row.get(id_idx as usize).cloned().unwrap_or_default() } else { String::new() };
    suite.insert("find_by_id".to_string(), serde_json::to_value(mgr.find_by_id("poste", &the_id).unwrap()).unwrap());
    suite.insert("links".to_string(), mgr.links_for_pole(&pole).unwrap());
    suite.insert("distinct_material".to_string(), serde_json::to_value(mgr.distinct("poste", "MATERIAL", 10).unwrap()).unwrap());
    suite.insert("bounds".to_string(), mgr.index_bounds("poste").unwrap());
    suite.insert("hotspots".to_string(), mgr.hotspots("poste", 3).unwrap());
    suite.insert("viewport_bt".to_string(), serde_json::to_value(mgr.viewport("bt", w, e, s, n, 50).unwrap()).unwrap());
    suite.insert("viewport_mt".to_string(), serde_json::to_value(mgr.viewport("mt", w, e, s, n, 50).unwrap()).unwrap());
    suite.insert("viewport_inst".to_string(), serde_json::to_value(mgr.viewport("inst", w, e, s, n, 50).unwrap()).unwrap());
    suite.insert("page_search".to_string(), mgr.page("poste", 10, 5, "CONCRETO", Some("NU_PG_ID"), 1).unwrap());

    println!("{}", serde_json::Value::Object(suite).to_string());
}
