use crate::api::uspto::{DocumentInfo, EventData};
use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Serialize, Deserialize)]
pub enum OfficeActionType {
    NonFinalRejection,
    FinalRejection,
    AdvisoryAction,
    RestrictionRequirement,
    NoticeOfAllowance,
    ExParteQuayle,
    Other(String),
}

impl OfficeActionType {
    pub fn from_document_code(code: &str) -> Self {
        match code {
            "CTNF" => OfficeActionType::NonFinalRejection,
            "CTF" => OfficeActionType::FinalRejection,
            "CTFR" => OfficeActionType::AdvisoryAction,
            "REST" => OfficeActionType::RestrictionRequirement,
            "NTCE" => OfficeActionType::NoticeOfAllowance,
            "EX.Q" => OfficeActionType::ExParteQuayle,
            other => OfficeActionType::Other(other.to_string()),
        }
    }

    pub fn display_name(&self) -> &str {
        match self {
            OfficeActionType::NonFinalRejection => "Non-Final Rejection",
            OfficeActionType::FinalRejection => "Final Rejection",
            OfficeActionType::AdvisoryAction => "Advisory Action",
            OfficeActionType::RestrictionRequirement => "Restriction Requirement",
            OfficeActionType::NoticeOfAllowance => "Notice of Allowance",
            OfficeActionType::ExParteQuayle => "Ex Parte Quayle",
            OfficeActionType::Other(s) => s,
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[allow(dead_code)]
pub struct ParsedOfficeAction {
    pub document_code: String,
    pub action_type: OfficeActionType,
    pub date: String,
    pub description: String,
    pub download_url: Option<String>,
    pub page_count: Option<i64>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[allow(dead_code)]
pub struct ExaminationTimeline {
    pub application_number: String,
    pub events: Vec<TimelineEvent>,
    pub office_actions: Vec<ParsedOfficeAction>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[allow(dead_code)]
pub struct TimelineEvent {
    pub date: String,
    pub code: String,
    pub description: String,
    pub category: EventCategory,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub enum EventCategory {
    OfficeAction,
    ApplicantResponse,
    FeePayment,
    StatusChange,
    Publication,
    Other,
}

impl EventCategory {
    pub fn from_event_code(code: &str) -> Self {
        match code {
            "CTNF" | "CTF" | "CTFR" | "REST" | "NTCE" | "EX.Q" | "EX.R" => {
                EventCategory::OfficeAction
            }
            "AMND" | "ROA" | "APEA" | "APB" => EventCategory::ApplicantResponse,
            "WFEE" | "FEES" | "ENT" | "PROV" => EventCategory::FeePayment,
            "PGPUB" | "ISS" => EventCategory::Publication,
            _ => EventCategory::Other,
        }
    }
}

#[allow(dead_code)]
pub fn parse_office_actions(documents: &[DocumentInfo]) -> Vec<ParsedOfficeAction> {
    documents
        .iter()
        .filter(|doc| {
            matches!(
                doc.document_code.as_deref(),
                Some("CTNF" | "CTF" | "CTFR" | "REST" | "NTCE" | "EX.Q" | "EX.R")
            )
        })
        .map(|doc| {
            let download_url = doc
                .download_option_bag
                .as_ref()
                .and_then(|opts| opts.first())
                .and_then(|opt| opt.download_url.clone());

            let page_count = doc
                .download_option_bag
                .as_ref()
                .and_then(|opts| opts.first())
                .and_then(|opt| opt.page_total_quantity);

            ParsedOfficeAction {
                document_code: doc.document_code.clone().unwrap_or_default(),
                action_type: OfficeActionType::from_document_code(
                    &doc.document_code.clone().unwrap_or_default(),
                ),
                date: doc.official_date.clone().unwrap_or_default(),
                description: doc
                    .document_code_description_text
                    .clone()
                    .unwrap_or_default(),
                download_url,
                page_count,
            }
        })
        .collect()
}

#[allow(dead_code)]
pub fn build_timeline(
    app_number: &str,
    events: &[EventData],
    documents: &[DocumentInfo],
) -> ExaminationTimeline {
    let timeline_events: Vec<TimelineEvent> = events
        .iter()
        .map(|event| TimelineEvent {
            date: event.event_date.clone().unwrap_or_default(),
            code: event.event_code.clone().unwrap_or_default(),
            description: event.event_description_text.clone().unwrap_or_default(),
            category: EventCategory::from_event_code(
                &event.event_code.clone().unwrap_or_default(),
            ),
        })
        .collect();

    let office_actions = parse_office_actions(documents);

    ExaminationTimeline {
        application_number: app_number.to_string(),
        events: timeline_events,
        office_actions,
    }
}
