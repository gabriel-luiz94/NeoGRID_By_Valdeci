//! Base gerada de um .zip: cada pasta vira regional, e a extração temporária some ao final.

use neogrid_build::{build_database, Options};
use std::io::Write;
use std::path::PathBuf;

const POSTE: &str = "NU_PG_ID;GEO_X;GEO_Y;NU_ALTURA\n";

fn temp_dir(name: &str) -> PathBuf {
    let dir = std::env::temp_dir().join(format!("neogrid-teste-{name}-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&dir);
    std::fs::create_dir_all(&dir).unwrap();
    dir
}

fn write_zip(path: &PathBuf, files: &[(&str, String)]) {
    let mut archive = zip::ZipWriter::new(std::fs::File::create(path).unwrap());
    let options = zip::write::SimpleFileOptions::default();
    for (name, text) in files {
        archive.start_file(*name, options).unwrap();
        archive.write_all(text.as_bytes()).unwrap();
    }
    archive.finish().unwrap();
}

fn options(source: PathBuf, output: PathBuf) -> Options {
    Options { source, output, manifesto_base: None, manifesto_out: None, reject_limit: 0.5, cancel: None, on_progress: None }
}

fn regional_dict(db: &PathBuf) -> (Vec<String>, Vec<i64>) {
    let conn = rusqlite::Connection::open(db).unwrap();
    let text: String = conn.query_row("SELECT value FROM meta WHERE key = 'schema'", [], |r| r.get(0)).unwrap();
    let schema: serde_json::Value = serde_json::from_str(&text).unwrap();
    let layer = &schema["layers"][0];
    assert!(layer["headers"].as_array().unwrap().iter().any(|h| h == "REGIONAL"));
    let dict: Vec<String> = layer["dicts"]["REGIONAL"]
        .as_array()
        .unwrap()
        .iter()
        .map(|v| v.as_str().unwrap().to_string())
        .collect();
    let mut stmt = conn.prepare("SELECT \"REGIONAL\" FROM poste ORDER BY _rid").unwrap();
    let codes = stmt.query_map([], |r| r.get(0)).unwrap().map(Result::unwrap).collect();
    (dict, codes)
}

#[test]
fn zip_com_pastas_vira_regionais_e_limpa_a_extracao() {
    let dir = temp_dir("regionais");
    let zip_path = dir.join("base.zip");
    write_zip(
        &zip_path,
        &[
            ("REGIONAL_A/Poste_a.csv", format!("{POSTE}1;-34.9;-8.0;11\n2;-34.8;-8.1;12\n")),
            ("REGIONAL_B/Poste_b.csv", format!("{POSTE}3;-35.0;-8.2;9\n")),
            ("../fora.csv", format!("{POSTE}9;-35.0;-8.2;9\n")),
        ],
    );
    let db = dir.join("saida.sqlite");
    let result = build_database(&options(zip_path, db.clone())).unwrap();
    assert_eq!(result.rows, 3, "a entrada que sai da pasta é ignorada");
    let (dict, codes) = regional_dict(&db);
    assert_eq!(dict, ["REGIONAL_A", "REGIONAL_B"]);
    assert_eq!(codes, [0, 0, 1]);
    let sobras: Vec<_> = std::fs::read_dir(&dir)
        .unwrap()
        .map(|e| e.unwrap().file_name().to_string_lossy().to_string())
        .filter(|n| n.starts_with(".neogrid-zip"))
        .collect();
    assert!(sobras.is_empty(), "pasta temporária ficou para trás: {sobras:?}");
    assert!(!dir.join("fora.csv").exists());
    std::fs::remove_dir_all(&dir).unwrap();
}

#[test]
fn pasta_envelope_usa_o_nivel_seguinte_como_regional() {
    let dir = temp_dir("envelope");
    let source = dir.join("extracao");
    for (sub, id) in [("BASE/REG_1", 1), ("BASE/REG_2", 2)] {
        let folder = source.join(sub);
        std::fs::create_dir_all(&folder).unwrap();
        std::fs::write(folder.join("Poste.csv"), format!("{POSTE}{id};-34.9;-8.0;11\n")).unwrap();
    }
    let db = dir.join("saida.sqlite");
    build_database(&options(source, db.clone())).unwrap();
    let (dict, _) = regional_dict(&db);
    assert_eq!(dict, ["REG_1", "REG_2"]);
    std::fs::remove_dir_all(&dir).unwrap();
}

#[test]
fn csv_sem_pasta_nao_ganha_coluna_de_regional() {
    let dir = temp_dir("plano");
    let source = dir.join("csv");
    std::fs::create_dir_all(&source).unwrap();
    std::fs::write(source.join("Poste.csv"), format!("{POSTE}1;-34.9;-8.0;11\n")).unwrap();
    let db = dir.join("saida.sqlite");
    build_database(&options(source, db.clone())).unwrap();
    let conn = rusqlite::Connection::open(&db).unwrap();
    let text: String = conn.query_row("SELECT value FROM meta WHERE key = 'schema'", [], |r| r.get(0)).unwrap();
    assert!(!text.contains("REGIONAL"));
    drop(conn);
    std::fs::remove_dir_all(&dir).unwrap();
}
