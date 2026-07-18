use reqwest::Client;
use std::time::Duration;
use thiserror::Error;

const GD_API_BASE: &str = "https://d1kazzu6rbodne.cloudfront.net";
const REQUEST_TIMEOUT_SECS: u64 = 30;
const MAX_RETRIES: u32 = 3;
const RETRY_INTERVAL_MS: u64 = 1500;

#[derive(Error, Debug)]
pub enum GlobalDossierError {
    #[error("HTTP request failed: {0}")]
    RequestFailed(#[from] reqwest::Error),
    #[error("Rate limited, retries exhausted")]
    #[allow(dead_code)]
    RateLimited,
    #[error("Not found: {0}")]
    NotFound(String),
    #[error("API error: {status} - {message}")]
    ApiError { status: u16, message: String },
}

#[derive(Debug, Clone)]
pub struct GlobalDossierClient {
    client: Client,
}

impl GlobalDossierClient {
    pub fn new() -> Self {
        let client = Client::builder()
            .user_agent("PatentHistoryHelper/0.1.0")
            .timeout(Duration::from_secs(REQUEST_TIMEOUT_SECS))
            .build()
            .unwrap_or_default();

        Self { client }
    }

    async fn get_with_retry(&self, url: &str) -> Result<reqwest::Response, GlobalDossierError> {
        let mut attempt = 0;
        loop {
            attempt += 1;
            let resp = self
                .client
                .get(url)
                .header("user-type", "external")
                .header("Referer", "https://globaldossier.uspto.gov/")
                .header("Origin", "https://globaldossier.uspto.gov")
                .send()
                .await;

            match resp {
                Ok(r) => {
                    let status = r.status();
                    if status.is_success() {
                        return Ok(r);
                    }
                    if status.as_u16() == 429 && attempt < MAX_RETRIES {
                        let delay = RETRY_INTERVAL_MS * 2u64.pow(attempt - 1);
                        tokio::time::sleep(Duration::from_millis(delay)).await;
                        continue;
                    }
                    if status.as_u16() == 404 {
                        let body = r.text().await.unwrap_or_default();
                        return Err(GlobalDossierError::NotFound(body));
                    }
                    let body = r.text().await.unwrap_or_default();
                    return Err(GlobalDossierError::ApiError {
                        status: status.as_u16(),
                        message: body,
                    });
                }
                Err(e) => {
                    if attempt < MAX_RETRIES {
                        let delay = RETRY_INTERVAL_MS * 2u64.pow(attempt - 1);
                        tokio::time::sleep(Duration::from_millis(delay)).await;
                        continue;
                    }
                    return Err(GlobalDossierError::RequestFailed(e));
                }
            }
        }
    }

    pub async fn get_family(
        &self,
        type_code: &str,
        office_code: &str,
        doc_number: &str,
    ) -> Result<serde_json::Value, GlobalDossierError> {
        let url = format!(
            "{}/patent-family/svc/family/{}/{}/{}",
            GD_API_BASE, type_code, office_code, doc_number
        );
        let resp = self.get_with_retry(&url).await?;
        let data = resp.json::<serde_json::Value>().await?;
        Ok(data)
    }

    pub async fn get_doc_list(
        &self,
        country: &str,
        doc_number: &str,
        kind_code: &str,
    ) -> Result<serde_json::Value, GlobalDossierError> {
        let url = format!(
            "{}/doc-list/svc/doclist/{}/{}/{}",
            GD_API_BASE, country, doc_number, kind_code
        );
        let resp = self.get_with_retry(&url).await?;
        let data = resp.json::<serde_json::Value>().await?;
        Ok(data)
    }

    pub async fn get_document(
        &self,
        country: &str,
        doc_number: &str,
        doc_id: &str,
        pages: &str,
        format: &str,
    ) -> Result<Vec<u8>, GlobalDossierError> {
        let url = format!(
            "{}/doc-content/svc/doccontent/{}/{}/{}/{}/{}",
            GD_API_BASE, country, doc_number, doc_id, pages, format
        );
        let resp = self.get_with_retry(&url).await?;
        let data = resp.bytes().await?.to_vec();
        Ok(data)
    }

    #[allow(dead_code)]
    pub async fn get_providing_offices(&self) -> Result<serde_json::Value, GlobalDossierError> {
        let url = format!("{}/patent-family/svc/wipo/providingoffices", GD_API_BASE);
        let resp = self.get_with_retry(&url).await?;
        let data = resp.json::<serde_json::Value>().await?;
        Ok(data)
    }

    #[allow(dead_code)]
    pub async fn search(
        &self,
        doc_number: &str,
        country: &str,
        type_code: &str,
    ) -> Result<serde_json::Value, GlobalDossierError> {
        let url = format!(
            "{}/search/svc/v2/lookup?docNumber={}&country={}&type={}",
            GD_API_BASE, doc_number, country, type_code
        );
        let resp = self.get_with_retry(&url).await?;
        let data = resp.json::<serde_json::Value>().await?;
        Ok(data)
    }
}

impl Default for GlobalDossierClient {
    fn default() -> Self {
        Self::new()
    }
}
