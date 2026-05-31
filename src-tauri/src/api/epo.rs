use chrono::{DateTime, Utc};
use reqwest::Client;
use serde::{Deserialize, Serialize};
use std::env;
use std::sync::Arc;
use std::time::Duration;
use thiserror::Error;
use tokio::sync::RwLock;

const EPO_AUTH_URL: &str = "https://ops.epo.org/3.2/auth/accesstoken";
const EPO_API_BASE: &str = "https://ops.epo.org/3.2/rest-services";
const REQUEST_INTERVAL_MS: u64 = 1500;
const REQUEST_TIMEOUT_SECS: u64 = 30;
const MAX_RETRIES: u32 = 3;
const TOKEN_REFRESH_MARGIN_SECS: i64 = 60;

#[derive(Error, Debug)]
pub enum EpoApiError {
    #[error("EPO credentials not configured. Set EPO_CONSUMER_KEY and EPO_CONSUMER_SECRET in .env file")]
    MissingCredentials,
    #[error("OAuth2 authentication failed: {0}")]
    AuthFailed(String),
    #[error("HTTP request failed: {0}")]
    RequestFailed(#[from] reqwest::Error),
    #[error("Rate limited (429). Retries exhausted")]
    RateLimited,
    #[error("Patent not found: {0}")]
    NotFound(String),
    #[error("API error: {status} - {message}")]
    ApiError { status: u16, message: String },
}

#[derive(Debug)]
struct CachedToken {
    access_token: String,
    expires_at: DateTime<Utc>,
}

#[derive(Debug, Deserialize)]
struct TokenResponse {
    access_token: String,
    expires_in: u64,
}

#[derive(Debug, Clone)]
pub struct EpoClient {
    client: Client,
    consumer_key: String,
    consumer_secret: String,
    token: Arc<RwLock<Option<CachedToken>>>,
}

#[derive(Debug, Serialize, Deserialize)]
pub struct EpoBiblioResponse {
    #[serde(rename = "ops:world-patent-data")]
    pub world_patent_data: Option<EpoWorldPatentData>,
}

#[derive(Debug, Serialize, Deserialize)]
pub struct EpoLegalResponse {
    #[serde(rename = "ops:world-patent-data")]
    pub world_patent_data: Option<EpoWorldPatentData>,
}

#[derive(Debug, Serialize, Deserialize)]
pub struct EpoRegisterResponse {
    #[serde(rename = "ops:world-patent-data")]
    pub world_patent_data: Option<EpoWorldPatentData>,
}

#[derive(Debug, Serialize, Deserialize)]
pub struct EpoFamilyResponse {
    #[serde(rename = "ops:world-patent-data")]
    pub world_patent_data: Option<EpoWorldPatentData>,
}

#[derive(Debug, Serialize, Deserialize)]
pub struct EpoWorldPatentData {
    #[serde(rename = "exchange-documents")]
    pub exchange_documents: Option<serde_json::Value>,
    #[serde(rename = "legal-status")]
    pub legal_status: Option<serde_json::Value>,
    #[serde(rename = "register-documents")]
    pub register_documents: Option<serde_json::Value>,
    #[serde(rename = "patent-family")]
    pub patent_family: Option<serde_json::Value>,
    #[serde(rename = "ops:meta")]
    pub meta: Option<serde_json::Value>,
}

impl EpoClient {
    pub fn new() -> Result<Self, EpoApiError> {
        let consumer_key = env::var("EPO_CONSUMER_KEY").map_err(|_| EpoApiError::MissingCredentials)?;
        let consumer_secret = env::var("EPO_CONSUMER_SECRET").map_err(|_| EpoApiError::MissingCredentials)?;

        let client = Client::builder()
            .user_agent("PatentHistoryHelper/0.1.0")
            .timeout(Duration::from_secs(REQUEST_TIMEOUT_SECS))
            .build()?;

        Ok(Self {
            client,
            consumer_key,
            consumer_secret,
            token: Arc::new(RwLock::new(None)),
        })
    }

    async fn get_access_token(&self) -> Result<String, EpoApiError> {
        {
            let token_read = self.token.read().await;
            if let Some(cached) = token_read.as_ref() {
                if cached.expires_at > Utc::now() + chrono::Duration::seconds(TOKEN_REFRESH_MARGIN_SECS) {
                    return Ok(cached.access_token.clone());
                }
            }
        }

        let params = [("grant_type", "client_credentials")];
        let resp = self
            .client
            .post(EPO_AUTH_URL)
            .basic_auth(&self.consumer_key, Some(&self.consumer_secret))
            .form(&params)
            .send()
            .await
            .map_err(|e| EpoApiError::AuthFailed(e.to_string()))?;

        if !resp.status().is_success() {
            let status = resp.status().as_u16();
            let body = resp.text().await.unwrap_or_default();
            return Err(EpoApiError::AuthFailed(format!("{} - {}", status, body)));
        }

        let token_data: TokenResponse = resp
            .json()
            .await
            .map_err(|e| EpoApiError::AuthFailed(e.to_string()))?;

        let expires_at = Utc::now() + chrono::Duration::seconds(token_data.expires_in as i64);
        let access_token = token_data.access_token.clone();

        {
            let mut token_write = self.token.write().await;
            *token_write = Some(CachedToken {
                access_token: token_data.access_token,
                expires_at,
            });
        }

        Ok(access_token)
    }

    async fn get_with_retry(&self, url: &str) -> Result<reqwest::Response, EpoApiError> {
        let mut last_error = None;

        for attempt in 0..=MAX_RETRIES {
            if attempt > 0 {
                let delay = Duration::from_millis(REQUEST_INTERVAL_MS * 2u64.pow(attempt - 1));
                tokio::time::sleep(delay).await;
            }

            let access_token = self.get_access_token().await?;

            let response = self
                .client
                .get(url)
                .header("Authorization", format!("Bearer {}", access_token))
                .header("Accept", "application/json")
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
                        last_error = Some(EpoApiError::RateLimited);
                        continue;
                    }
                    if status == 401 {
                        log::warn!("Token expired, refreshing (attempt {}/{})", attempt + 1, MAX_RETRIES);
                        {
                            let mut token_write = self.token.write().await;
                            *token_write = None;
                        }
                        last_error = Some(EpoApiError::AuthFailed("Token expired".to_string()));
                        continue;
                    }
                    if status == 404 {
                        let body = resp.text().await.unwrap_or_default();
                        return Err(EpoApiError::NotFound(body));
                    }
                    let body = resp.text().await.unwrap_or_default();
                    return Err(EpoApiError::ApiError { status, message: body });
                }
                Err(e) => {
                    last_error = Some(EpoApiError::RequestFailed(e));
                }
            }
        }

        Err(last_error.unwrap_or(EpoApiError::RateLimited))
    }

    pub async fn get_biblio(&self, pub_number: &str) -> Result<EpoBiblioResponse, EpoApiError> {
        let url = format!(
            "{}/published-data/publication/epodoc/{}/biblio",
            EPO_API_BASE, pub_number
        );
        let resp = self.get_with_retry(&url).await?;
        let data = resp.json::<EpoBiblioResponse>().await?;
        Ok(data)
    }

    pub async fn get_legal_status(&self, pub_number: &str) -> Result<EpoLegalResponse, EpoApiError> {
        let url = format!(
            "{}/published-data/publication/epodoc/{}/legal",
            EPO_API_BASE, pub_number
        );
        let resp = self.get_with_retry(&url).await?;
        let data = resp.json::<EpoLegalResponse>().await?;
        Ok(data)
    }

    pub async fn get_register(&self, pub_number: &str) -> Result<EpoRegisterResponse, EpoApiError> {
        let url = format!(
            "{}/register/publication/epodoc/{}",
            EPO_API_BASE, pub_number
        );
        let resp = self.get_with_retry(&url).await?;
        let data = resp.json::<EpoRegisterResponse>().await?;
        Ok(data)
    }

    pub async fn get_family(&self, pub_number: &str) -> Result<EpoFamilyResponse, EpoApiError> {
        let url = format!(
            "{}/family/publication/epodoc/{}",
            EPO_API_BASE, pub_number
        );
        let resp = self.get_with_retry(&url).await?;
        let data = resp.json::<EpoFamilyResponse>().await?;
        Ok(data)
    }
}
