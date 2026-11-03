//! Leitura streaming de linhas CSV a partir do texto decodificado.
//! Espelha `db-build.js: streamRows` (Papa + `skipEmptyLines: 'greedy'`).
//!
//! O Papa remove linhas em branco ANTES do callback, tolera registros com
//! erro (conta `parseErrors`) e numera a partir dai: cabecalho = linha 1,
//! primeiro dado = linha 2, sequencial.

/// Visita cada linha de dados com `(numero_da_linha, registro, bytes_lidos)`.
/// `bytes_lidos` e aproximado (soma das linhas + 1 por quebra) e serve para
/// a barra de progresso, como o `cursor` do Papa.
/// O callback retorna `false` para abortar (cancelamento); o retorno indica
/// se todas as linhas foram visitadas.
pub fn for_each_row(
    text: &str,
    delimiter: char,
    mut f: impl FnMut(u64, &csv::StringRecord, u64) -> bool,
) -> bool {
    let mut rdr = csv::ReaderBuilder::new()
        .delimiter(delimiter as u8)
        .has_headers(false)
        .flexible(true)
        .from_reader(text.as_bytes());
    let mut logical: u64 = 0; // 0 = cabecalho
    let mut consumed: u64 = 0;
    for res in rdr.records() {
        let record = match res {
            Ok(r) => r,
            Err(_) => continue, // como o Papa: ignora o registro, segue o baile
        };
        consumed += record.as_slice().len() as u64 + 1;
        if !record.iter().any(|c| !c.trim().is_empty()) {
            continue;
        }
        if logical == 0 {
            logical = 1; // cabecalho consumido (linha 1)
            continue;
        }
        logical += 1;
        if !f(logical, &record, consumed) {
            return false;
        }
    }
    true
}
