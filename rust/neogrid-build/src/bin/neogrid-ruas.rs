//! Uso: neogrid-ruas <extrato.osm.pbf> <saida.neogrid-ruas> [data]
//! Gera o pacote de ruas offline sem abrir o aplicativo.

use neogrid_build::ruas::{build_pack, PackEvent};
use std::path::Path;
use std::sync::Arc;

fn main() {
    let args: Vec<String> = std::env::args().skip(1).collect();
    if args.len() < 2 {
        eprintln!("Uso: neogrid-ruas <extrato.osm.pbf> <saida.neogrid-ruas> [data]");
        std::process::exit(2);
    }
    let data = args.get(2).cloned().unwrap_or_default();
    let origem = Path::new(&args[0]).file_name().unwrap_or_default().to_string_lossy().to_string();
    let on_event = Arc::new(|e: PackEvent| match e {
        PackEvent::Etapa(nome, Some(f)) => println!("{nome}: {:.0}%", f * 100.0),
        PackEvent::Etapa(nome, None) => println!("{nome}…"),
        PackEvent::Log(texto) => println!("{texto}"),
    });
    let started = std::time::Instant::now();
    match build_pack(Path::new(&args[0]), Path::new(&args[1]), &origem, &data, None, Some(on_event)) {
        Ok(info) => {
            println!(
                "OK: {} vias, {} ladrilhos, {:.1} MB em {:.0} s",
                info.vias,
                info.ladrilhos,
                info.bytes as f64 / 1_048_576.0,
                started.elapsed().as_secs_f64()
            );
            for (tipo, n) in &info.por_tipo {
                println!("  {tipo}: {n}");
            }
        }
        Err(error) => {
            eprintln!("ERRO: {error}");
            std::process::exit(1);
        }
    }
}
