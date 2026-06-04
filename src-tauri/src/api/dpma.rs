use reqwest::Client;
use serde::{Deserialize, Serialize};
use std::time::Duration;
use thiserror::Error;

const DPMA_REGISTER_BASE: &str = "https://register.dpma.de";
const REQUEST_TIMEOUT_SECS: u64 = 30;
const MAX_RETRIES: u32 = 3;
const RETRY_INTERVAL_MS: u64 = 1500;

#[derive(Error, Debug)]
pub enum DpmaError {
    #[error("HTTP request failed: {0}")]
    RequestFailed(#[from] reqwest::Error),
    #[error("Rate limited, retries exhausted")]
    RateLimited,
    #[error("Patent not found: {0}")]
    NotFound(String),
    #[error("API error: {status} - {message}")]
    ApiError { status: u16, message: String },
    #[error("Parse error: {0}")]
    ParseError(String),
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DpmaDocumentEntry {
    pub document_id: String,
    pub document_type: Option<String>,
    pub document_description: Option<String>,
    pub document_date: Option<String>,
    pub page_count: Option<i64>,
    pub download_url: Option<String>,
    pub doc_category: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DpmaFileInspection {
    pub file_number: String,
    pub documents: Vec<DpmaDocumentEntry>,
}

#[derive(Debug, Clone)]
pub struct DpmaClient {
    client: Client,
}

impl DpmaClient {
    pub fn new() -> Self {
        let client = Client::builder()
            .user_agent("Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/149.0.0.0 Safari/537.36")
            .timeout(Duration::from_secs(REQUEST_TIMEOUT_SECS))
            .build()
            .unwrap_or_default();

        Self { client }
    }

    async fn get_with_retry(&self, url: &str) -> Result<reqwest::Response, DpmaError> {
        let mut last_error = None;

        for attempt in 0..=MAX_RETRIES {
            if attempt > 0 {
                let delay = Duration::from_millis(RETRY_INTERVAL_MS * 2u64.pow(attempt - 1));
                tokio::time::sleep(delay).await;
            }

            let response = self
                .client
                .get(url)
                .header("Accept", "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8")
                .header("Accept-Language", "de,en-US;q=0.7,en;q=0.3")
                .send()
                .await;

            match response {
                Ok(resp) => {
                    let status = resp.status();
                    if status.is_success() {
                        return Ok(resp);
                    }
                    let status_code = status.as_u16();
                    if status_code == 429 {
                        log::warn!("DPMA rate limited, retrying (attempt {}/{})", attempt + 1, MAX_RETRIES);
                        last_error = Some(DpmaError::RateLimited);
                        continue;
                    }
                    if status_code == 404 {
                        let body = resp.text().await.unwrap_or_default();
                        return Err(DpmaError::NotFound(body));
                    }
                    let body = resp.text().await.unwrap_or_default();
                    return Err(DpmaError::ApiError { status: status_code, message: body });
                }
                Err(e) => {
                    last_error = Some(DpmaError::RequestFailed(e));
                }
            }
        }

        Err(last_error.unwrap_or(DpmaError::RateLimited))
    }

    pub async fn search_patent(&self, file_number: &str) -> Result<String, DpmaError> {
        let url = format!(
            "{}/DPMAregister/pat/experte?search={}",
            DPMA_REGISTER_BASE,
            urlencoding::encode(file_number)
        );
        let resp = self.get_with_retry(&url).await?;
        let html = resp.text().await?;
        Ok(html)
    }

    pub async fn get_file_inspection(&self, file_number: &str) -> Result<DpmaFileInspection, DpmaError> {
        let search_html = self.search_patent(file_number).await?;
        let inspection_url = self.extract_inspection_url(&search_html, file_number)?;
        let resp = self.get_with_retry(&inspection_url).await?;
        let inspection_html = resp.text().await?;
        let documents = self.parse_inspection_documents(&inspection_html)?;

        Ok(DpmaFileInspection {
            file_number: file_number.to_string(),
            documents,
        })
    }

    pub async fn download_document(&self, document_url: &str) -> Result<Vec<u8>, DpmaError> {
        let full_url = if document_url.starts_with("http") {
            document_url.to_string()
        } else {
            format!("{}{}", DPMA_REGISTER_BASE, document_url)
        };

        let resp = self
            .client
            .get(&full_url)
            .header("Accept", "application/pdf,*/*")
            .send()
            .await?;

        if !resp.status().is_success() {
            let status = resp.status().as_u16();
            let body = resp.text().await.unwrap_or_default();
            return Err(DpmaError::ApiError { status, message: body });
        }

        let bytes = resp.bytes().await?.to_vec();
        Ok(bytes)
    }

    fn extract_inspection_url(&self, html: &str, file_number: &str) -> Result<String, DpmaError> {
        if let Some(url) = self.find_link_by_pattern(html, "Akteneinsicht") {
            return Ok(if url.starts_with("http") { url } else { format!("{}{}", DPMA_REGISTER_BASE, url) });
        }
        Ok(format!(
            "{}/DPMAregister/pat/Akteneinsicht?fileNumber={}",
            DPMA_REGISTER_BASE,
            urlencoding::encode(file_number)
        ))
    }

    fn find_link_by_pattern(&self, html: &str, pattern: &str) -> Option<String> {
        let lower_html = html.to_lowercase();
        let pattern_lower = pattern.to_lowercase();
        if let Some(idx) = lower_html.find(&pattern_lower) {
            let before = &html[..idx];
            if let Some(href_start) = before.rfind("href=\"") {
                let url_start = href_start + 6;
                if let Some(url_end) = html[url_start..].find('"') {
                    return Some(html[url_start..url_start + url_end].to_string());
                }
            }
        }
        None
    }

    fn parse_inspection_documents(&self, html: &str) -> Result<Vec<DpmaDocumentEntry>, DpmaError> {
        let mut documents = Vec::new();
        let mut pos = 0;
        let html_lower = html.to_lowercase();

        while let Some(row_start) = html_lower[pos..].find("<tr") {
            let row_start_abs = pos + row_start;
            if let Some(row_end) = html[row_start_abs..].find("</tr>") {
                let row = &html[row_start_abs..row_start_abs + row_end + 5];
                if let Some(pdf_link) = self.extract_pdf_link(row) {
                    let cells: Vec<String> = self.extract_table_cells(row);
                    let doc_type = cells.get(0).cloned();
                    let doc_date = cells.get(1).cloned();
                    let doc_category = doc_type.as_ref().map(|dt| self.classify_de_document(dt)).flatten();

                    documents.push(DpmaDocumentEntry {
                        document_id: format!("DE_{}", documents.len()),
                        document_type: doc_type,
                        document_description: None,
                        document_date: doc_date,
                        page_count: None,
                        download_url: Some(pdf_link),
                        doc_category,
                    });
                }
                pos = row_start_abs + row_end + 5;
            } else {
                break;
            }
        }

        if documents.is_empty() {
            let pdf_links = self.extract_all_pdf_links(html);
            for (idx, link) in pdf_links.into_iter().enumerate() {
                documents.push(DpmaDocumentEntry {
                    document_id: format!("DE_{}", idx),
                    document_type: None,
                    document_description: None,
                    document_date: None,
                    page_count: None,
                    download_url: Some(link),
                    doc_category: None,
                });
            }
        }

        Ok(documents)
    }

    fn extract_pdf_link(&self, html: &str) -> Option<String> {
        let lower = html.to_lowercase();
        if !lower.contains(".pdf") && !lower.contains("download") && !lower.contains("document") {
            return None;
        }
        if let Some(href_idx) = lower.find("href=\"") {
            let url_start = href_idx + 6;
            if let Some(url_end) = html[url_start..].find('"') {
                let url = &html[url_start..url_start + url_end];
                if url.contains(".pdf") || url.contains("download") || url.contains("Akteneinsicht") {
                    let full_url = if url.starts_with("http") {
                        url.to_string()
                    } else if url.starts_with("/") {
                        format!("{}{}", DPMA_REGISTER_BASE, url)
                    } else {
                        format!("{}/{}", DPMA_REGISTER_BASE, url)
                    };
                    return Some(full_url);
                }
            }
        }
        None
    }

    fn extract_all_pdf_links(&self, html: &str) -> Vec<String> {
        let mut links = Vec::new();
        let lower = html.to_lowercase();
        let mut pos = 0;

        while let Some(href_idx) = lower[pos..].find("href=\"") {
            let abs_idx = pos + href_idx;
            let url_start = abs_idx + 6;
            if let Some(url_end) = html[url_start..].find('"') {
                let url = &html[url_start..url_start + url_end];
                if url.contains(".pdf") || (url.contains("Akteneinsicht") && url.contains("download")) {
                    let full_url = if url.starts_with("http") {
                        url.to_string()
                    } else if url.starts_with("/") {
                        format!("{}{}", DPMA_REGISTER_BASE, url)
                    } else {
                        format!("{}/{}", DPMA_REGISTER_BASE, url)
                    };
                    links.push(full_url);
                }
                pos = url_start + url_end + 1;
            } else {
                break;
            }
        }
        links
    }

    fn extract_table_cells(&self, row: &str) -> Vec<String> {
        let mut cells = Vec::new();
        let mut pos = 0;
        while let Some(td_start) = row[pos..].find("<td") {
            let abs_start = pos + td_start;
            if let Some(content_start) = row[abs_start..].find('>') {
                let content_start_abs = abs_start + content_start + 1;
                if let Some(content_end) = row[content_start_abs..].find("</td>") {
                    let content = &row[content_start_abs..content_start_abs + content_end];
                    cells.push(self.strip_html_tags(content).to_string());
                    pos = content_start_abs + content_end + 5;
                } else { break; }
            } else { break; }
        }
        cells
    }

    fn strip_html_tags(&self, html: &str) -> String {
        let mut result = html.to_string();
        while let Some(start) = result.find('<') {
            if let Some(end) = result[start..].find('>') {
                result.replace_range(start..start + end + 1, "");
            } else { break; }
        }
        result
    }

    fn classify_de_document(&self, doc_type: &str) -> Option<String> {
        let lower = doc_type.to_lowercase();
        if lower.contains("prüfungsbescheid") || lower.contains("bescheid") {
            Some("office_action".to_string())
        } else if lower.contains("recherchebericht") {
            Some("office_action".to_string())
        } else if lower.contains("erteilungsbescheid") {
            Some("allowance".to_string())
        } else if lower.contains("patentschrift") {
            Some("allowance".to_string())
        } else if lower.contains("eingabe") || lower.contains("antwort") {
            Some("response".to_string())
        } else if lower.contains("prüfungsantrag") {
            Some("request".to_string())
        } else if lower.contains("offenlegungsschrift") {
            Some("notification".to_string())
        } else if lower.contains("einspruch") {
            Some("notification".to_string())
        } else {
            Some("misc".to_string())
        }
    }
}

impl Default for DpmaClient {
    fn default() -> Self {
        Self::new()
    }
}
