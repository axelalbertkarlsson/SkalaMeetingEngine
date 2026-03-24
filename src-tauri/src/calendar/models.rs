use chrono::Utc;
use serde::{Deserialize, Serialize};
use uuid::Uuid;

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum CalendarSourceKind {
    IcsImport,
    IcsSubscription,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CalendarSourceRecord {
    pub id: String,
    pub workspace_id: String,
    pub workspace_root: String,
    pub kind: CalendarSourceKind,
    pub name: String,
    pub url: Option<String>,
    pub file_name: Option<String>,
    pub stored_path: String,
    pub created_at: String,
    pub last_synced_at: Option<String>,
    pub last_sync_error: Option<String>,
}

impl CalendarSourceRecord {
    pub fn new(
        workspace_id: String,
        workspace_root: String,
        kind: CalendarSourceKind,
        name: String,
        url: Option<String>,
        file_name: Option<String>,
        stored_path: String,
    ) -> Self {
        let created_at = now_iso();
        let last_synced_at = if matches!(kind, CalendarSourceKind::IcsImport) {
            Some(created_at.clone())
        } else {
            None
        };

        Self {
            id: format!("calendar-source-{}", Uuid::new_v4()),
            workspace_id,
            workspace_root,
            kind,
            name,
            url,
            file_name,
            stored_path,
            created_at,
            last_synced_at,
            last_sync_error: None,
        }
    }
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CalendarSourceSnapshot {
    pub source: CalendarSourceRecord,
    pub content: Option<String>,
    pub fetched_at: String,
    pub stale: bool,
    pub error: Option<String>,
}

pub fn now_iso() -> String {
    Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Secs, true)
}
