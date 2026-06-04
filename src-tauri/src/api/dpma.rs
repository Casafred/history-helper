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
    #[error("File inspection not available: {0}")]
    InspectionNotAvailable(String),
    #[error("API error: {status} - {message}")]
    ApiError { status: u16, message: String },
    #[error("Parse error: {0}")]
    ParseError(String),
}

/// Document entry from DPMAregister file inspection
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

/// File inspection result from DPMAregister
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DpmaFileInspection {
    pub file_number: String,
    pub documents: Vec<DpmaDocumentEntry>,
}

/// DPMAregister client for accessing German patent file inspection
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

    /// Core GET request with retry
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

    /// Search for a patent in DPMAregister and get the register page
    /// file_number: DE patent file number (e.g., "102022123456")
    pub async fn search_patent(
        &self,
        file_number: &str,
    ) -> Result<String, DpmaError> {
        // Use the expert search API endpoint
        let url = format!(
            "{}/DPMAregister/pat/experte?search={}",
            DPMA_REGISTER_BASE,
            urlencoding::encode(file_number)
        );

        let resp = self.get_with_retry(&url).await?;
        let html = resp.text().await?;
        Ok(html)
    }

    /// Get file inspection documents for a patent
    /// This accesses the Akteneinsicht (file inspection) feature
    pub async fn get_file_inspection(
        &self,
        file_number: &str,
    ) -> Result<DpmaFileInspection, DpmaError> {
        // Step 1: Search for the patent to get the register entry
        let search_html = self.search_patent(file_number).await?;

        // Step 2: Extract the file inspection URL from the search results
        // DPMAregister uses a specific URL pattern for file inspection
        let inspection_url = self.extract_inspection_url(&search_html, file_number)?;

        // Step 3: Access the file inspection page
        let resp = self.get_with_retry(&inspection_url).await?;
        let inspection_html = resp.text().await?;

        // Step 4: Parse the document list from the inspection page
        let documents = self.parse_inspection_documents(&inspection_html)?;

        Ok(DpmaFileInspection {
            file_number: file_number.to_string(),
            documents,
        })
    }

    /// Download a specific document PDF from DPMAregister file inspection
    pub async fn download_document(
        &self,
        document_url: &str,
    ) -> Result<Vec<u8>, DpmaError> {
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

    /// Extract file inspection URL from DPMAregister search results HTML
    fn extract_inspection_url(&self, html: &str, file_number: &str) -> Result<String, DpmaError> {
        // DPMAregister search results contain links to register entries
        // The file inspection is accessed via a specific URL pattern:
        // /DPMAregister/pat/Akteneinsicht?fileNumber={number}

        // Try to find the direct file inspection link
        if let Some(url) = self.find_link_by_pattern(html, "Akteneinsicht") {
            return Ok(if url.starts_with("http") {
                url
            } else {
                format!("{}{}", DPMA_REGISTER_BASE, url)
            });
        }

        // Fallback: construct the URL directly
        // The DPMAregister file inspection URL follows a known pattern
        Ok(format!(
            "{}/DPMAregister/pat/Akteneinsicht?fileNumber={}",
            DPMA_REGISTER_BASE,
            urlencoding::encode(file_number)
        ))
    }

    /// Find a link in HTML containing a specific pattern
    fn find_link_by_pattern(&self, html: &str, pattern: &str) -> Option<String> {
        // Simple regex-free link extraction
        // Look for href="..." containing the pattern
        let lower_html = html.to_lowercase();
        let pattern_lower = pattern.to_lowercase();

        if let Some(idx) = lower_html.find(&pattern_lower) {
            // Search backwards for href="
            let before = &html[..idx];
            if let Some(href_start) = before.rfind("href=\"") {
                let url_start = href_start + 6;
                if let Some(url_end) = html[url_start..].find('"') {
                    return Some(html[url_start..url_start + url_end].to_string());
                }
            }
            // Also try href='
            if let Some(href_start) = before.rfind("href='") {
                let url_start = href_start + 6;
                if let Some(url_end) = html[url_start..].find('\'') {
                    return Some(html[url_start..url_start + url_end].to_string());
                }
            }
        }
        None
    }

    /// Parse document entries from the file inspection HTML page
    fn parse_inspection_documents(&self, html: &str) -> Result<Vec<DpmaDocumentEntry>, DpmaError> {
        let mut documents = Vec::new();

        // DPMAregister file inspection shows a table of documents
        // Each row contains: document type, date, link to PDF

        // Parse the document table - look for rows with document links
        // The typical structure is:
        // <tr><td>Document Type</td><td>Date</td><td><a href="...">PDF</a></td></tr>

        // Simple HTML parsing without full DOM parser
        let mut pos = 0;
        let html_lower = html.to_lowercase();

        // Find document table rows
        while let Some(row_start) = html_lower[pos..].find("<tr") {
            let row_start_abs = pos + row_start;
            if let Some(row_end) = html[row_start_abs..].find("</tr>") {
                let row = &html[row_start_abs..row_start_abs + row_end + 5];

                // Check if this row contains a PDF link
                if let Some(pdf_link) = self.extract_pdf_link(row) {
                    let cells: Vec<&str> = self.extract_table_cells(row);

                    let doc_type = cells.get(0).map(|s| s.trim().to_string());
                    let doc_date = cells.get(1).map(|s| s.trim().to_string());

                    // Classify the document based on its German description
                    let doc_category = doc_type
                        .as_ref()
                        .map(|dt| self.classify_de_document(dt))
                        .unwrap_or(None);

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

        // If no documents found via table parsing, try alternative approach
        // DPMAregister may use a different HTML structure (e.g., JSON data embedded in page)
        if documents.is_empty() {
            // Try to find all PDF links in the page
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

    /// Extract a PDF link from an HTML row
    fn extract_pdf_link(&self, html: &str) -> Option<String> {
        let lower = html.to_lowercase();
        if !lower.contains(".pdf") && !lower.contains("download") && !lower.contains("document") {
            return None;
        }

        // Find href containing PDF or document download
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

    /// Extract all PDF links from HTML
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

    /// Extract table cell contents from an HTML row
    fn extract_table_cells(&self, row: &str) -> Vec<&str> {
        let mut cells = Vec::new();
        let mut pos = 0;

        while let Some(td_start) = row[pos..].find("<td") {
            let abs_start = pos + td_start;
            // Skip to end of opening tag
            if let Some(content_start) = row[abs_start..].find('>') {
                let content_start_abs = abs_start + content_start + 1;
                if let Some(content_end) = row[content_start_abs..].find("</td>") {
                    let content = &row[content_start_abs..content_start_abs + content_end];
                    // Strip HTML tags from content
                    let stripped = self.strip_html_tags(content);
                    cells.push(stripped);
                    pos = content_start_abs + content_end + 5;
                } else {
                    break;
                }
            } else {
                break;
            }
        }

        cells
    }

    /// Strip HTML tags from text
    fn strip_html_tags(&self, html: &str) -> &str {
        // Simple tag stripping - find first > after < and content before next <
        // For a more robust solution, use an HTML parser
        let mut result = html.to_string();
        while let Some(start) = result.find('<') {
            if let Some(end) = result[start..].find('>') {
                result.replace_range(start..start + end + 1, "");
            } else {
                break;
            }
        }
        // Leak the string to get a &'static str - this is fine for our use case
        // as these strings are short-lived
        Box::leak(result.into_boxed_str())
    }

    /// Classify a German document type into a category
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
