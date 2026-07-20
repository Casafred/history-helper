use regex::Regex;
use reqwest::Client;
use serde_json::json;
use std::sync::OnceLock;
use std::time::Duration;
use thiserror::Error;

const EPO_REGISTER_BASE: &str = "https://register.epo.org";
const REQUEST_TIMEOUT_SECS: u64 = 30;

#[derive(Error, Debug)]
pub enum EpoRegisterError {
    #[error("HTTP request failed: {0}")]
    RequestFailed(#[from] reqwest::Error),
    #[error("Cloudflare verification required - please open EPO Register in browser first")]
    CloudflareRequired,
    #[error("Not found: {0}")]
    NotFound(String),
    #[error("Parse error: {0}")]
    ParseError(String),
    #[error("API error: {status} - {message}")]
    ApiError { status: u16, message: String },
}

#[derive(Debug, Clone)]
pub struct EpoRegisterClient {
    client: Client,
}

#[derive(Debug, Clone)]
pub struct EpoDocEntry {
    pub doc_id: String,
    pub date: String,
    pub name: String,
    pub desc: String,
    pub pages: u32,
    pub phase: String,
    pub is_gd_doc: bool,
    pub apn: String,
}

fn ep_doc_row_re() -> &'static Regex {
    static RE: OnceLock<Regex> = OnceLock::new();
    RE.get_or_init(|| {
        Regex::new(r#"<tr>\s*<td[^>]*>\s*<input[^>]*type="checkbox"[^>]*value="([^"]+)"[^>]*>\s*</td>\s*<td[^>]*>([^<]*)</td>\s*<td[^>]*>(?:<a[^>]*>)?(.*?)(?:</a>)?</td>\s*<td[^>]*>(.*?)</td>\s*<td[^>]*>([^<]*)</td>"#).unwrap()
    })
}

fn gd_doc_row_re() -> &'static Regex {
    static RE: OnceLock<Regex> = OnceLock::new();
    RE.get_or_init(|| {
        Regex::new(r#"<tr>\s*<td[^>]*>([^<]+)</td>\s*<td[^>]*>\s*<a[^>]*href="[^"]*documentId=([A-Z0-9]+)[^"]*"[^>]*>([^<]+)</a>\s*</td>\s*<td[^>]*>([^<]*)</td>"#).unwrap()
    })
}

fn html_unescape(s: &str) -> String {
    s.replace("&nbsp;", " ")
        .replace("&amp;", "&")
        .replace("&lt;", "<")
        .replace("&gt;", ">")
        .replace("&quot;", "\"")
        .replace("&#39;", "'")
        .replace("&apos;", "'")
        .trim()
        .to_string()
}

impl EpoRegisterClient {
    pub fn new() -> Self {
        let client = Client::builder()
            .user_agent("Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36")
            .timeout(Duration::from_secs(REQUEST_TIMEOUT_SECS))
            .cookie_store(true)
            .build()
            .unwrap_or_default();

        Self { client }
    }

    fn detect_cloudflare(html: &str) -> bool {
        let lower = html.to_lowercase();
        (lower.contains("performing security verification")
            || lower.contains("just a moment")
            || lower.contains("ray id:"))
            && lower.contains("cloudflare")
    }

    fn format_apn(office: &str, doc_number: &str, kind_code: &str) -> String {
        format!("{}.{}.{}", office, doc_number, kind_code)
    }

    fn normalize_date(date_str: &str) -> String {
        let cleaned = date_str.trim();
        let parts: Vec<&str> = cleaned.split('.').collect();
        if parts.len() == 3 && parts[0].len() == 2 && parts[1].len() == 2 && parts[2].len() == 4 {
            format!("{}-{}-{}", parts[2], parts[1], parts[0])
        } else {
            cleaned.to_string()
        }
    }

    fn classify_doc(desc: &str) -> (String, String, String) {
        Self::classify_doc_epo(desc, "")
    }

    fn classify_doc_epo(desc: &str, phase: &str) -> (String, String, String) {
        let lower = desc.to_lowercase();
        let _phase_lower = phase.to_lowercase();
        let mut doc_type = String::from("misc");
        let mut stage = String::from("其他");

        let doc_code = if lower.contains("non-final rejection") || lower.contains("ctnf") {
            doc_type = "office_action".to_string();
            stage = "审查意见".to_string();
            "CTNF"
        } else if lower.contains("final rejection") || lower.contains("ctfr") {
            doc_type = "office_action".to_string();
            stage = "审查意见".to_string();
            "CTFR"
        } else if lower.contains("office action")
            || (lower.contains("communication") && !lower.contains("power of attorney"))
            || lower.contains("examination report")
            || lower.contains("examination communication")
        {
            doc_type = "office_action".to_string();
            stage = "审查意见".to_string();
            "OA"
        } else if lower.contains("search opinion")
            || lower.contains("written opinion")
            || lower.contains("esop")
            || lower.contains("search strategy")
        {
            doc_type = "office_action".to_string();
            stage = "审查意见".to_string();
            "ESOP"
        } else if lower.contains("european search report")
            || (lower.contains("search report") && !lower.contains("search strategy"))
            || lower.contains("esr")
        {
            doc_type = "citation".to_string();
            stage = "审查员引用".to_string();
            "ESR"
        } else if lower.contains("amendment after non-final")
            || lower.contains("amendment/request")
            || (lower.contains("amendment") && !lower.contains("acknowledgment"))
            || lower.contains("response")
            || lower.contains("reply")
            || lower.contains("observations")
            || (lower.contains("remarks") && !lower.contains("extension of time"))
            || lower.contains("arguments")
            || lower.contains("request for reconsideration")
        {
            doc_type = "response".to_string();
            stage = "申请人答复".to_string();
            "AMD"
        } else if lower.contains("notice of allowance")
            || lower.contains("intention to grant")
            || lower.contains("grant notification")
            || lower.contains("issue notification")
            || lower.contains("decision to grant")
            || lower.contains("grant of patent")
            || (lower.contains("allowance") && !lower.contains("fee"))
        {
            doc_type = "allowance".to_string();
            stage = "授权通知".to_string();
            "NOA"
        } else if lower.contains("information disclosure")
            || lower.contains("(ids)")
            || lower.contains("list of references")
            || lower.contains("cited by examiner")
            || lower.contains("references cited")
            || lower.contains("cited references")
            || lower.contains("reference(s)")
        {
            doc_type = "citation".to_string();
            stage = "审查员引用".to_string();
            "IDS"
        } else if lower.contains("opposition") {
            stage = "异议".to_string();
            "OPP"
        } else if lower.contains("claims") {
            doc_type = "patent_doc".to_string();
            stage = "专利文件".to_string();
            "CLM"
        } else if lower.contains("specification") {
            doc_type = "patent_doc".to_string();
            stage = "专利文件".to_string();
            "SPEC"
        } else if lower.contains("drawings") {
            doc_type = "patent_doc".to_string();
            stage = "专利文件".to_string();
            "DWG"
        } else if lower.contains("abstract") {
            doc_type = "patent_doc".to_string();
            stage = "专利文件".to_string();
            "ABST"
        } else if lower.contains("filing receipt") {
            doc_type = "notification".to_string();
            stage = "通知".to_string();
            "FREC"
        } else if lower.contains("notice of publication") {
            doc_type = "patent_doc".to_string();
            stage = "专利文件".to_string();
            "PUB"
        } else if lower.contains("entry into european phase") || lower.contains("european phase") {
            doc_type = "notification".to_string();
            stage = "通知".to_string();
            "EPEN"
        } else if lower.contains("power of attorney") {
            doc_type = "notification".to_string();
            stage = "通知".to_string();
            "POA"
        } else if lower.contains("change of address") {
            doc_type = "notification".to_string();
            stage = "通知".to_string();
            "NTFN"
        } else if lower.contains("fee worksheet") || lower.contains("issue fee") {
            doc_type = "notification".to_string();
            stage = "通知".to_string();
            "FEE"
        } else if lower.contains("extension of time") || lower.contains("authorization for extension") {
            doc_type = "notification".to_string();
            stage = "通知".to_string();
            "EXT"
        } else if lower.contains("transmittal") {
            doc_type = "notification".to_string();
            stage = "通知".to_string();
            "TRANS"
        } else if lower.contains("withdrawn") || lower.contains("refused") || lower.contains("deemed") {
            doc_type = "notification".to_string();
            stage = "通知".to_string();
            "NTFN"
        } else if lower.contains("assignee") || lower.contains("ownership") {
            "ASGN"
        } else if lower.contains("electronic filing") || lower.contains("acknowledgment") {
            doc_type = "notification".to_string();
            stage = "通知".to_string();
            "FREC"
        } else if lower.contains("bibliographic data") {
            doc_type = "patent_doc".to_string();
            stage = "专利文件".to_string();
            "BDS"
        } else if lower.contains("declaration") || lower.contains("oath") {
            "DEC"
        } else if lower.contains("publication") {
            doc_type = "patent_doc".to_string();
            stage = "专利文件".to_string();
            "PUB"
        } else {
            "MISC"
        };

        (doc_code.to_string(), doc_type, stage)
    }

    fn parse_ep_doclist(html: &str, app_number: &str) -> Result<Vec<EpoDocEntry>, EpoRegisterError> {
        let mut docs = Vec::new();
        let re = ep_doc_row_re();

        for caps in re.captures_iter(html) {
            let doc_id = caps.get(1).map(|m| m.as_str().to_string()).unwrap_or_default();
            let date_raw = caps.get(2).map(|m| m.as_str().to_string()).unwrap_or_default();
            let desc_html = caps.get(3).map(|m| m.as_str().to_string()).unwrap_or_default();
            let phase_html = caps.get(4).map(|m| m.as_str().to_string()).unwrap_or_default();
            let pages_str = caps.get(5).map(|m| m.as_str().to_string()).unwrap_or_default();

            let date = html_unescape(&date_raw);
            let desc = html_unescape(&desc_html);
            let phase = html_unescape(&phase_html);
            let pages: u32 = pages_str.trim().parse().unwrap_or(1);

            if doc_id.is_empty() || desc.is_empty() || date.is_empty() {
                continue;
            }

            docs.push(EpoDocEntry {
                doc_id,
                date: Self::normalize_date(&date),
                name: desc.clone(),
                desc,
                pages,
                phase,
                is_gd_doc: false,
                apn: format!("EP{}", app_number),
            });
        }

        Ok(docs)
    }

    fn parse_gd_doclist(html: &str, apn: &str) -> Result<Vec<EpoDocEntry>, EpoRegisterError> {
        let mut docs = Vec::new();
        let re = gd_doc_row_re();

        for caps in re.captures_iter(html) {
            let date_raw = caps.get(1).map(|m| m.as_str().to_string()).unwrap_or_default();
            let doc_id = caps.get(2).map(|m| m.as_str().to_string()).unwrap_or_default();
            let desc_raw = caps.get(3).map(|m| m.as_str().to_string()).unwrap_or_default();
            let pages_str = caps.get(4).map(|m| m.as_str().to_string()).unwrap_or_default();

            let date = html_unescape(&date_raw);
            let desc = html_unescape(&desc_raw);
            let pages: u32 = pages_str.trim().parse().unwrap_or(1);

            if doc_id.is_empty() || desc.is_empty() || date.is_empty() {
                continue;
            }

            docs.push(EpoDocEntry {
                doc_id,
                date: Self::normalize_date(&date),
                name: desc.clone(),
                desc,
                pages,
                phase: String::new(),
                is_gd_doc: true,
                apn: apn.to_string(),
            });
        }

        Ok(docs)
    }

    pub async fn get_doc_list(
        &self,
        office: &str,
        doc_number: &str,
        kind_code: &str,
    ) -> Result<serde_json::Value, EpoRegisterError> {
        let is_ep = office.eq_ignore_ascii_case("EP");

        if is_ep {
            let url = format!(
                "{}/application?number=EP{}&lng=en&tab=doclist",
                EPO_REGISTER_BASE, doc_number
            );
            let resp = self.client.get(&url).send().await?;

            if resp.status() == 404 {
                return Err(EpoRegisterError::NotFound(format!(
                    "EP{} not found in EPO Register",
                    doc_number
                )));
            }

            if !resp.status().is_success() {
                return Err(EpoRegisterError::ApiError {
                    status: resp.status().as_u16(),
                    message: resp.text().await.unwrap_or_default(),
                });
            }

            let html = resp.text().await?;

            if Self::detect_cloudflare(&html) {
                return Err(EpoRegisterError::CloudflareRequired);
            }

            if html.contains("No files were found") || html.contains("No files containing") {
                return Ok(json!({
                    "docs": [],
                    "title": "",
                    "docNumber": doc_number,
                    "source": "EPO Register",
                    "totalDocs": 0
                }));
            }

            let entries = Self::parse_ep_doclist(&html, doc_number)?;

            let docs: Vec<serde_json::Value> = entries
                .iter()
                .map(|e| {
                    let (doc_code, _doc_type, _stage) = Self::classify_doc_epo(&e.desc, &e.phase);
                    json!({
                        "docId": e.doc_id,
                        "docCode": doc_code,
                        "docDesc": e.desc,
                        "documentDescription": e.desc,
                        "documentDate": e.date,
                        "date": e.date,
                        "numberOfPages": e.pages,
                        "docFormat": "pdf",
                        "documentType": doc_code,
                        "countryCode": office,
                        "epoDocType": if e.is_gd_doc { "gd" } else { "ep" },
                        "apn": e.apn,
                    })
                })
                .collect();

            Ok(json!({
                "docs": docs,
                "title": "",
                "docNumber": doc_number,
                "source": "EPO Register",
                "totalDocs": docs.len()
            }))
        } else {
            let apn = Self::format_apn(office, doc_number, kind_code);
            let url = format!(
                "{}/ipfwretrieve?apn={}&lng=en",
                EPO_REGISTER_BASE,
                urlencoding::encode(&apn)
            );

            let resp = self.client.get(&url).send().await?;

            if resp.status() == 404 {
                return Err(EpoRegisterError::NotFound(format!(
                    "{} not found in EPO Global Dossier",
                    apn
                )));
            }

            if !resp.status().is_success() {
                return Err(EpoRegisterError::ApiError {
                    status: resp.status().as_u16(),
                    message: resp.text().await.unwrap_or_default(),
                });
            }

            let mut html = resp.text().await?;

            if Self::detect_cloudflare(&html) {
                return Err(EpoRegisterError::CloudflareRequired);
            }

            if html.contains("Dossier documents are being retrieved") {
                tokio::time::sleep(Duration::from_secs(8)).await;
                let resp2 = self.client.get(&url).send().await?;
                html = resp2.text().await?;
                if Self::detect_cloudflare(&html) {
                    return Err(EpoRegisterError::CloudflareRequired);
                }
            }

            self.parse_gd_to_json(&html, &apn, office, doc_number)
        }
    }

    fn parse_gd_to_json(
        &self,
        html: &str,
        apn: &str,
        office: &str,
        doc_number: &str,
    ) -> Result<serde_json::Value, EpoRegisterError> {
        if html.contains("No dossier") || html.contains("not available") {
            return Ok(json!({
                "docs": [],
                "title": "",
                "docNumber": doc_number,
                "source": "EPO Global Dossier",
                "totalDocs": 0
            }));
        }

        let entries = Self::parse_gd_doclist(html, apn)?;

        let docs: Vec<serde_json::Value> = entries
            .iter()
            .map(|e| {
                let (doc_code, _dt, _st) = Self::classify_doc(&e.desc);
                json!({
                    "docId": e.doc_id,
                    "docCode": doc_code,
                    "docDesc": e.desc,
                    "documentDescription": e.desc,
                    "documentDate": e.date,
                    "date": e.date,
                    "numberOfPages": e.pages,
                    "docFormat": "pdf",
                    "documentType": doc_code,
                    "countryCode": office,
                    "epoDocType": if e.is_gd_doc { "gd" } else { "ep" },
                    "apn": e.apn,
                })
            })
            .collect();

        Ok(json!({
            "docs": docs,
            "title": "",
            "docNumber": doc_number,
            "source": "EPO Global Dossier",
            "totalDocs": docs.len()
        }))
    }

    pub async fn get_document_pdf(
        &self,
        doc_id: &str,
        apn: &str,
        is_gd_doc: bool,
    ) -> Result<Vec<u8>, EpoRegisterError> {
        let url = if is_gd_doc {
            format!(
                "{}/ipApplication?documentId={}&number={}&patentScope=false",
                EPO_REGISTER_BASE,
                urlencoding::encode(doc_id),
                urlencoding::encode(apn)
            )
        } else {
            let ep_num = apn.trim_start_matches("EP");
            format!(
                "{}/application?showPdfPage=1&documentId={}&appnumber=EP{}&proc=",
                EPO_REGISTER_BASE,
                urlencoding::encode(doc_id),
                ep_num
            )
        };

        let resp = self.client.get(&url).send().await?;

        if !resp.status().is_success() {
            return Err(EpoRegisterError::ApiError {
                status: resp.status().as_u16(),
                message: resp.text().await.unwrap_or_default(),
            });
        }

        let content_type = resp
            .headers()
            .get("content-type")
            .and_then(|v| v.to_str().ok())
            .unwrap_or("")
            .to_string();

        let bytes = resp.bytes().await?.to_vec();

        if content_type.contains("text/html") {
            let html = String::from_utf8_lossy(&bytes);
            if Self::detect_cloudflare(&html) {
                return Err(EpoRegisterError::CloudflareRequired);
            }
        }

        if bytes.len() < 100 {
            return Err(EpoRegisterError::NotFound(
                "Document content is empty or too small".to_string(),
            ));
        }

        Ok(bytes)
    }

    pub async fn get_document_pdf_by_office(
        &self,
        office: &str,
        doc_number: &str,
        doc_id: &str,
    ) -> Result<Vec<u8>, EpoRegisterError> {
        let is_ep = office.eq_ignore_ascii_case("EP");
        if is_ep {
            let apn = format!("EP{}", doc_number);
            self.get_document_pdf(doc_id, &apn, false).await
        } else {
            let kind_code = "A";
            let apn = format!("{}.{}.{}", office, doc_number, kind_code);
            self.get_document_pdf(doc_id, &apn, true).await
        }
    }

    pub async fn status(&self) -> Result<serde_json::Value, EpoRegisterError> {
        Ok(json!({
            "configured": true,
            "office": "EP",
            "source": "EPO Register (register.epo.org)"
        }))
    }
}

impl Default for EpoRegisterClient {
    fn default() -> Self {
        Self::new()
    }
}
