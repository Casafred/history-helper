use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PatentSearchResult {
    pub application_number: String,
    pub status: String,
    pub filing_date: Option<String>,
    pub invention_title: Option<String>,
    pub applicant: Option<String>,
    pub examiner: Option<String>,
    pub patent_number: Option<String>,
    pub grant_date: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ExaminationHistory {
    pub application_number: String,
    pub timeline: Vec<HistoryEvent>,
    pub office_actions: Vec<OfficeActionSummary>,
    pub continuity: ContinuityInfo,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct HistoryEvent {
    pub date: String,
    pub code: String,
    pub description: String,
    pub category: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct OfficeActionSummary {
    pub date: String,
    pub action_type: String,
    pub document_code: String,
    pub download_url: Option<String>,
    pub page_count: Option<i64>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ContinuityInfo {
    pub parent_applications: Vec<String>,
    pub child_applications: Vec<String>,
    pub foreign_priorities: Vec<ForeignPriorityInfo>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ForeignPriorityInfo {
    pub country_code: String,
    pub date: String,
    pub number: String,
}
