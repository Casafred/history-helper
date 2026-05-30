use reqwest::Client;
use serde::{Deserialize, Serialize};
use std::env;
use std::time::Duration;
use thiserror::Error;

const USPTO_API_BASE: &str = "https://api.uspto.gov/api/v1/patent/applications";
const REQUEST_INTERVAL_MS: u64 = 1500;
const REQUEST_TIMEOUT_SECS: u64 = 30;
const MAX_RETRIES: u32 = 3;

#[derive(Error, Debug)]
pub enum UsptoApiError {
    #[error("API key not configured. Set USPTO_API_KEY in .env file")]
    MissingApiKey,
    #[error("HTTP request failed: {0}")]
    RequestFailed(#[from] reqwest::Error),
    #[error("Rate limited (429). Retries exhausted")]
    RateLimited,
    #[error("Application not found: {0}")]
    NotFound(String),
    #[error("API error: {status} - {message}")]
    ApiError { status: u16, message: String },
}

#[derive(Debug, Clone)]
pub struct UsptoClient {
    client: Client,
    api_key: String,
}

#[derive(Debug, Serialize, Deserialize)]
pub struct PatentApplicationResponse {
    pub count: Option<i64>,
    #[serde(rename = "patentFileWrapperDataBag")]
    pub patent_file_wrapper_data_bag: Option<Vec<PatentFileWrapperData>>,
}

#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PatentFileWrapperData {
    pub application_number_text: Option<String>,
    pub application_meta_data: Option<ApplicationMetaData>,
    pub event_data_bag: Option<Vec<EventData>>,
    pub parent_continuity_bag: Option<Vec<ParentContinuityData>>,
    pub child_continuity_bag: Option<Vec<ChildContinuityData>>,
    pub foreign_priority_bag: Option<Vec<ForeignPriority>>,
}

#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ApplicationMetaData {
    pub filing_date: Option<String>,
    pub application_type_label_name: Option<String>,
    pub application_status_code: Option<i64>,
    pub application_status_description_text: Option<String>,
    pub invention_title: Option<String>,
    pub examiner_name_text: Option<String>,
    pub first_applicant_name: Option<String>,
    pub grant_date: Option<String>,
    pub patent_number: Option<String>,
    pub group_art_unit_number: Option<String>,
    pub class: Option<String>,
    pub subclass: Option<String>,
}

#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct EventData {
    pub event_date: Option<String>,
    pub event_code: Option<String>,
    pub event_description_text: Option<String>,
}

#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ParentContinuityData {
    pub parent_application_number_text: Option<String>,
    pub parent_application_status_code: Option<i64>,
    pub parent_application_status_description_text: Option<String>,
    pub continuity_type_code: Option<String>,
}

#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ChildContinuityData {
    pub child_application_number_text: Option<String>,
    pub child_application_status_code: Option<i64>,
    pub child_application_status_description_text: Option<String>,
    pub continuity_type_code: Option<String>,
}

#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ForeignPriority {
    pub foreign_priority_country_code: Option<String>,
    pub foreign_priority_date: Option<String>,
    pub foreign_priority_number_text: Option<String>,
}

#[derive(Debug, Serialize, Deserialize)]
pub struct DocumentBagResponse {
    #[serde(rename = "documentBag")]
    pub document_bag: Option<Vec<DocumentInfo>>,
}

#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DocumentInfo {
    pub application_number_text: Option<String>,
    pub official_date: Option<String>,
    pub document_identifier: Option<String>,
    pub document_code: Option<String>,
    pub document_code_description_text: Option<String>,
    pub document_direction_category: Option<String>,
    pub download_option_bag: Option<Vec<DownloadOption>>,
}

#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DownloadOption {
    pub mime_type_identifier: Option<String>,
    pub download_url: Option<String>,
    pub page_total_quantity: Option<i64>,
}

impl UsptoClient {
    pub fn new() -> Result<Self, UsptoApiError> {
        let api_key = env::var("USPTO_API_KEY").map_err(|_| UsptoApiError::MissingApiKey)?;

        let client = Client::builder()
            .user_agent("PatentHistoryHelper/0.1.0")
            .timeout(Duration::from_secs(REQUEST_TIMEOUT_SECS))
            .build()?;

        Ok(Self { client, api_key })
    }

    async fn get_with_retry(&self, url: &str) -> Result<reqwest::Response, UsptoApiError> {
        let mut last_error = None;

        for attempt in 0..=MAX_RETRIES {
            if attempt > 0 {
                let delay = Duration::from_millis(REQUEST_INTERVAL_MS * 2u64.pow(attempt - 1));
                tokio::time::sleep(delay).await;
            }

            let response = self
                .client
                .get(url)
                .header("X-API-KEY", &self.api_key)
                .send()
                .await;

            match response {
                Ok(resp) => {
                    if resp.status().is_success() {
                        return Ok(resp);
                    }
                    let status = resp.status().as_u16();
                    if status == 429 {
                        log::warn!("Rate limited, retrying (attempt {}/{})", attempt + 1, MAX_RETRIES);
                        last_error = Some(UsptoApiError::RateLimited);
                        continue;
                    }
                    if status == 404 {
                        let body = resp.text().await.unwrap_or_default();
                        return Err(UsptoApiError::NotFound(body));
                    }
                    let body = resp.text().await.unwrap_or_default();
                    return Err(UsptoApiError::ApiError {
                        status,
                        message: body,
                    });
                }
                Err(e) => {
                    last_error = Some(UsptoApiError::RequestFailed(e));
                }
            }
        }

        Err(last_error.unwrap_or(UsptoApiError::RateLimited))
    }

    pub async fn get_application(
        &self,
        app_number: &str,
    ) -> Result<PatentApplicationResponse, UsptoApiError> {
        let url = format!("{}/{}", USPTO_API_BASE, app_number);
        let resp = self.get_with_retry(&url).await?;
        let data = resp.json::<PatentApplicationResponse>().await?;
        Ok(data)
    }

    pub async fn get_application_meta(
        &self,
        app_number: &str,
    ) -> Result<PatentApplicationResponse, UsptoApiError> {
        let url = format!("{}/{}/meta-data", USPTO_API_BASE, app_number);
        let resp = self.get_with_retry(&url).await?;
        let data = resp.json::<PatentApplicationResponse>().await?;
        Ok(data)
    }

    pub async fn get_transactions(
        &self,
        app_number: &str,
    ) -> Result<PatentApplicationResponse, UsptoApiError> {
        let url = format!("{}/{}/transactions", USPTO_API_BASE, app_number);
        let resp = self.get_with_retry(&url).await?;
        let data = resp.json::<PatentApplicationResponse>().await?;
        Ok(data)
    }

    pub async fn get_documents(
        &self,
        app_number: &str,
    ) -> Result<DocumentBagResponse, UsptoApiError> {
        let url = format!("{}/{}/documents", USPTO_API_BASE, app_number);
        let resp = self.get_with_retry(&url).await?;
        let data = resp.json::<DocumentBagResponse>().await?;
        Ok(data)
    }

    pub async fn get_continuity(
        &self,
        app_number: &str,
    ) -> Result<PatentApplicationResponse, UsptoApiError> {
        let url = format!("{}/{}/continuity", USPTO_API_BASE, app_number);
        let resp = self.get_with_retry(&url).await?;
        let data = resp.json::<PatentApplicationResponse>().await?;
        Ok(data)
    }

    pub async fn get_foreign_priority(
        &self,
        app_number: &str,
    ) -> Result<PatentApplicationResponse, UsptoApiError> {
        let url = format!("{}/{}/foreign-priority", USPTO_API_BASE, app_number);
        let resp = self.get_with_retry(&url).await?;
        let data = resp.json::<PatentApplicationResponse>().await?;
        Ok(data)
    }
}
