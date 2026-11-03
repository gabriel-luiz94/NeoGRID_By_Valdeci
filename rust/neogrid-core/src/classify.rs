//! Espelha `electron/db-build.js: classifyFileByName/classifyByHeaders`
//! + `LAYER_MARKERS`. Ordem preservada: inst -> mt -> bt -> poste.

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Layer {
    Poste,
    Bt,
    Mt,
    Inst,
}

impl Layer {
    pub fn as_str(self) -> &'static str {
        match self {
            Layer::Poste => "poste",
            Layer::Bt => "bt",
            Layer::Mt => "mt",
            Layer::Inst => "inst",
        }
    }
}

/// Normaliza para comparacao: minusculas, sem acentos comuns (via NFD manual simples).
fn fold_name(file: &str) -> String {
    let base = file.rsplit(['/', '\\']).next().unwrap_or(file).to_lowercase();
    // remove diacriticos dos casos que importam (instalacoes etc.)
    base.chars()
        .map(|c| match c {
            'á' | 'à' | 'â' | 'ã' => 'a',
            'é' | 'ê' => 'e',
            'í' => 'i',
            'ó' | 'ô' | 'õ' => 'o',
            'ú' | 'ü' => 'u',
            'ç' => 'c',
            _ => c,
        })
        .collect()
}

pub fn classify_file_by_name(file: &str) -> Option<Layer> {
    let name = fold_name(file);
    if name.contains("instalac") {
        return Some(Layer::Inst);
    }
    // rede_mt / _mt_ / -mt- ; evita casar "companheira" etc: exige separador ou inicio
    let has_mt = name.contains("rede_mt")
        || name.contains("rede-mt")
        || name.contains("rede mt")
        || name.contains("_mt")
        || name.contains("-mt")
        || name.contains(" mt")
        || name.starts_with("mt");
    if has_mt {
        return Some(Layer::Mt);
    }
    let has_bt = name.contains("rede_bt")
        || name.contains("rede-bt")
        || name.contains("rede bt")
        || name.contains("_bt")
        || name.contains("-bt")
        || name.contains(" bt")
        || name.starts_with("bt");
    if has_bt {
        return Some(Layer::Bt);
    }
    if name.contains("poste") {
        return Some(Layer::Poste);
    }
    None
}

fn has_exact(headers: &[String], target: &str) -> bool {
    headers.iter().any(|h| h == target)
}

fn has_prefix(headers: &[String], prefix: &str) -> bool {
    headers.iter().any(|h| h.starts_with(prefix))
}

pub fn classify_by_headers(headers: &[String]) -> Option<Layer> {
    let has_inst = has_exact(headers, "TIPO_SIGLA") || has_exact(headers, "TIPO_INSTA");
    let has_mt = has_prefix(headers, "NU_TRECHO_MT") || has_prefix(headers, "NU_CONDUTOR_MT");
    let has_bt = has_prefix(headers, "NU_TRECHO_BT") || has_prefix(headers, "NU_CONDUTOR_BT");
    let has_poste = has_exact(headers, "NU_ALTURA")
        || has_exact(headers, "NU_ESFORCO")
        || has_exact(headers, "DE_BARRAMEN")
        || has_exact(headers, "TIPO_PG");
    // Ordem do JS: inst primeiro, depois mt (se nao houver bt), bt, poste.
    if has_inst {
        return Some(Layer::Inst);
    }
    if has_mt && !has_bt {
        return Some(Layer::Mt);
    }
    if has_bt {
        return Some(Layer::Bt);
    }
    if has_poste {
        return Some(Layer::Poste);
    }
    None
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn nomes_reais() {
        assert_eq!(
            classify_file_by_name("Poste_regional_2.csv"),
            Some(Layer::Poste)
        );
        assert_eq!(
            classify_file_by_name("Rede_BT_regiional_2.csv"),
            Some(Layer::Bt)
        );
        assert_eq!(
            classify_file_by_name("Rede_MT_regional_2.csv"),
            Some(Layer::Mt)
        );
        assert_eq!(
            classify_file_by_name("Instalacao_regional_2.csv"),
            Some(Layer::Inst)
        );
        assert_eq!(
            classify_file_by_name("instalações.csv"),
            Some(Layer::Inst)
        );
    }

    #[test]
    fn cabecalho_manda_na_ambiguidade() {
        // CSV de instalacao carrega NU_TRECHO_MT_ID mas tem TIPO_SIGLA -> inst
        let h = vec![
            "NU_TRECHO_MT_ID".to_string(),
            "TIPO_SIGLA".to_string(),
            "NU_PG_ID".to_string(),
        ];
        assert_eq!(classify_by_headers(&h), Some(Layer::Inst));
    }
}
