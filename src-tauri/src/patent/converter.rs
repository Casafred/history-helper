use serde::{Deserialize, Serialize};
use std::fmt;

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub enum PatentOffice {
    US,
    CN,
    EP,
    JP,
    DE,
    KR,
    WO,
}

impl fmt::Display for PatentOffice {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            PatentOffice::US => write!(f, "US"),
            PatentOffice::CN => write!(f, "CN"),
            PatentOffice::EP => write!(f, "EP"),
            PatentOffice::JP => write!(f, "JP"),
            PatentOffice::DE => write!(f, "DE"),
            PatentOffice::KR => write!(f, "KR"),
            PatentOffice::WO => write!(f, "WO"),
        }
    }
}

impl PatentOffice {
    pub fn display_name(&self) -> &str {
        match self {
            PatentOffice::US => "美国 (USPTO)",
            PatentOffice::CN => "中国 (CNIPA)",
            PatentOffice::EP => "欧洲 (EPO)",
            PatentOffice::JP => "日本 (JPO)",
            PatentOffice::DE => "德国 (DPMA)",
            PatentOffice::KR => "韩国 (KIPO)",
            PatentOffice::WO => "世界知识产权组织 (WIPO/PCT)",
        }
    }

    pub fn supports_examination_history(&self) -> bool {
        matches!(self, PatentOffice::US | PatentOffice::EP | PatentOffice::JP | PatentOffice::DE | PatentOffice::WO)
    }

    pub fn api_unavailable_message(&self) -> Option<String> {
        match self {
            PatentOffice::CN => Some("中国国家知识产权局 (CNIPA) 暂无公开 API，请访问 cnipa.gov.cn 网站查询".to_string()),
            PatentOffice::KR => Some("韩国特许厅 (KIPO) KIPRIS API 需单独注册，请访问 kipris.or.kr 网站查询".to_string()),
            _ => None,
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PatentNumber {
    pub office: PatentOffice,
    pub raw: String,
    pub application_number: Option<String>,
    pub publication_number: Option<String>,
    pub patent_number: Option<String>,
    pub filing_date: Option<String>,
}

#[derive(Debug, thiserror::Error)]
pub enum ConversionError {
    #[error("Unrecognized patent number format: {0}")]
    UnrecognizedFormat(String),
    #[error("Invalid patent number: {0}")]
    InvalidNumber(String),
    #[error("Conversion not supported: {from} -> {to}")]
    #[allow(dead_code)]
    NotSupported { from: String, to: String },
}

pub fn detect_office(number: &str) -> Option<PatentOffice> {
    let upper = number.trim().to_uppercase();
    if upper.starts_with("US") || (upper.starts_with("1") && upper.len() == 8) {
        Some(PatentOffice::US)
    } else if upper.starts_with("CN") {
        Some(PatentOffice::CN)
    } else if upper.starts_with("EP") {
        Some(PatentOffice::EP)
    } else if upper.starts_with("JP") {
        Some(PatentOffice::JP)
    } else if upper.starts_with("DE") {
        Some(PatentOffice::DE)
    } else if upper.starts_with("KR") {
        Some(PatentOffice::KR)
    } else if upper.starts_with("WO") || upper.starts_with("PCT") {
        Some(PatentOffice::WO)
    } else {
        None
    }
}

pub fn normalize_us_application_number(input: &str) -> Result<String, ConversionError> {
    let digits: String = input
        .trim()
        .trim_start_matches("US")
        .chars()
        .filter(|c| c.is_ascii_digit())
        .collect();

    if digits.is_empty() {
        return Err(ConversionError::InvalidNumber(input.to_string()));
    }

    if digits.len() == 8 {
        Ok(digits)
    } else if digits.len() > 8 {
        let series: String = digits[..2].to_string();
        let serial: String = digits[2..].to_string();
        Ok(format!("{}/{}", series, serial))
    } else {
        Err(ConversionError::InvalidNumber(input.to_string()))
    }
}

pub fn normalize_cn_application_number(input: &str) -> Result<String, ConversionError> {
    let trimmed = input.trim().to_uppercase();
    let cleaned = trimmed.trim_start_matches("CN").replace(".", "");

    if cleaned.is_empty() {
        return Err(ConversionError::InvalidNumber(input.to_string()));
    }

    Ok(format!("CN{}", cleaned))
}

pub fn normalize_ep_application_number(input: &str) -> Result<String, ConversionError> {
    let trimmed = input.trim().to_uppercase();
    let cleaned = trimmed
        .trim_start_matches("EP")
        .replace(" ", "")
        .replace(".", "");

    if cleaned.is_empty() {
        return Err(ConversionError::InvalidNumber(input.to_string()));
    }

    Ok(format!("EP{}", cleaned))
}

pub fn normalize_wo_application_number(input: &str) -> Result<String, ConversionError> {
    let trimmed = input.trim().to_uppercase();
    let cleaned = trimmed
        .trim_start_matches("WO")
        .trim_start_matches("PCT")
        .replace(" ", "")
        .replace("/", "");

    if cleaned.is_empty() {
        return Err(ConversionError::InvalidNumber(input.to_string()));
    }

    Ok(format!("WO{}", cleaned))
}

pub fn normalize_jp_application_number(input: &str) -> Result<String, ConversionError> {
    let trimmed = input.trim().to_uppercase();
    let cleaned = trimmed
        .trim_start_matches("JP")
        .replace(" ", "")
        .replace("-", "");

    if cleaned.is_empty() {
        return Err(ConversionError::InvalidNumber(input.to_string()));
    }

    // JPO API uses 出願番号 format: YYYYNNNNNN (4-digit year + 6-digit serial)
    let digits: String = cleaned.chars().filter(|c| c.is_ascii_digit()).collect();
    if digits.len() >= 10 {
        Ok(digits)
    } else {
        Ok(format!("JP{}", cleaned))
    }
}

pub fn normalize_de_application_number(input: &str) -> Result<String, ConversionError> {
    let trimmed = input.trim().to_uppercase();
    let cleaned = trimmed
        .trim_start_matches("DE")
        .replace(" ", "")
        .replace(".", "");

    if cleaned.is_empty() {
        return Err(ConversionError::InvalidNumber(input.to_string()));
    }

    Ok(format!("DE{}", cleaned))
}

pub fn normalize_kr_application_number(input: &str) -> Result<String, ConversionError> {
    let trimmed = input.trim().to_uppercase();
    let cleaned = trimmed
        .trim_start_matches("KR")
        .replace(" ", "")
        .replace("-", "");

    if cleaned.is_empty() {
        return Err(ConversionError::InvalidNumber(input.to_string()));
    }

    Ok(format!("KR{}", cleaned))
}

pub fn parse_patent_number(input: &str) -> Result<PatentNumber, ConversionError> {
    let trimmed = input.trim();
    let office = detect_office(trimmed)
        .ok_or_else(|| ConversionError::UnrecognizedFormat(trimmed.to_string()))?;

    let application_number = match office {
        PatentOffice::US => Some(normalize_us_application_number(trimmed)?),
        PatentOffice::CN => Some(normalize_cn_application_number(trimmed)?),
        PatentOffice::EP => Some(normalize_ep_application_number(trimmed)?),
        PatentOffice::JP => Some(normalize_jp_application_number(trimmed)?),
        PatentOffice::DE => Some(normalize_de_application_number(trimmed)?),
        PatentOffice::KR => Some(normalize_kr_application_number(trimmed)?),
        PatentOffice::WO => Some(normalize_wo_application_number(trimmed)?),
    };

    Ok(PatentNumber {
        office,
        raw: trimmed.to_string(),
        application_number,
        publication_number: None,
        patent_number: None,
        filing_date: None,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_detect_office_us() {
        assert_eq!(detect_office("US14412875"), Some(PatentOffice::US));
        assert_eq!(detect_office("14412875"), Some(PatentOffice::US));
    }

    #[test]
    fn test_detect_office_cn() {
        assert_eq!(detect_office("CN202310000001.X"), Some(PatentOffice::CN));
    }

    #[test]
    fn test_detect_office_ep() {
        assert_eq!(detect_office("EP12345678"), Some(PatentOffice::EP));
    }

    #[test]
    fn test_normalize_us_application_number() {
        assert_eq!(
            normalize_us_application_number("14412875").unwrap(),
            "14412875"
        );
        assert_eq!(
            normalize_us_application_number("US14412875").unwrap(),
            "14412875"
        );
    }

    #[test]
    fn test_normalize_cn_application_number() {
        assert_eq!(
            normalize_cn_application_number("CN202310000001.X").unwrap(),
            "CN202310000001X"
        );
    }

    #[test]
    fn test_normalize_ep_application_number() {
        assert_eq!(
            normalize_ep_application_number("EP1234567").unwrap(),
            "EP1234567"
        );
        assert_eq!(
            normalize_ep_application_number("EP 12 34567").unwrap(),
            "EP1234567"
        );
    }

    #[test]
    fn test_normalize_wo_application_number() {
        assert_eq!(
            normalize_wo_application_number("WO2023/123456").unwrap(),
            "WO2023123456"
        );
        assert_eq!(
            normalize_wo_application_number("PCT/EP2023/123456").unwrap(),
            "WOEP2023123456"
        );
    }

    #[test]
    fn test_parse_patent_number() {
        let pn = parse_patent_number("US14412875").unwrap();
        assert_eq!(pn.office, PatentOffice::US);
        assert_eq!(pn.application_number, Some("14412875".to_string()));
    }

    #[test]
    fn test_detect_office_unknown() {
        assert_eq!(detect_office("12345"), None);
    }

    #[test]
    fn test_normalize_us_short_number() {
        assert!(normalize_us_application_number("123").is_err());
    }

    #[test]
    fn test_office_supports_examination() {
        assert!(PatentOffice::US.supports_examination_history());
        assert!(PatentOffice::EP.supports_examination_history());
        assert!(PatentOffice::WO.supports_examination_history());
        assert!(PatentOffice::JP.supports_examination_history());
        assert!(PatentOffice::DE.supports_examination_history());
        assert!(!PatentOffice::CN.supports_examination_history());
        assert!(!PatentOffice::KR.supports_examination_history());
    }
}
