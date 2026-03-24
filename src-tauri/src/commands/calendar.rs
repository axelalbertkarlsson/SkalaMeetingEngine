use std::{path::PathBuf, time::Duration};

use reqwest::blocking::Client;
use serde::{Deserialize, Serialize};

use crate::calendar::{
    models::{now_iso, CalendarSourceKind, CalendarSourceRecord, CalendarSourceSnapshot},
    store,
};

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CalendarWorkspaceRequest {
    pub workspace_id: String,
    pub workspace_root: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ImportCalendarSourceRequest {
    pub workspace_id: String,
    pub workspace_root: String,
    pub name: String,
    pub file_name: String,
    pub file_bytes: Vec<u8>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AddCalendarSubscriptionRequest {
    pub workspace_id: String,
    pub workspace_root: String,
    pub name: String,
    pub url: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RemoveCalendarSourceRequest {
    pub workspace_root: String,
    pub source_id: String,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct OperationAck {
    pub ok: bool,
    pub message: String,
}

#[tauri::command]
pub fn list_calendar_sources(
    request: CalendarWorkspaceRequest,
) -> Result<Vec<CalendarSourceRecord>, String> {
    let workspace_root = PathBuf::from(&request.workspace_root);
    let sources = store::list_sources(&workspace_root).map_err(|error| error.to_string())?;

    Ok(sources
        .into_iter()
        .filter(|source| source.workspace_id == request.workspace_id)
        .collect())
}

#[tauri::command]
pub fn import_calendar_source(
    request: ImportCalendarSourceRequest,
) -> Result<CalendarSourceRecord, String> {
    let workspace_root = PathBuf::from(&request.workspace_root);
    let name = if request.name.trim().is_empty() {
        request.file_name.trim()
    } else {
        request.name.trim()
    };

    store::import_source(
        &request.workspace_id,
        &workspace_root,
        name,
        &request.file_name,
        &request.file_bytes,
    )
    .map_err(|error| error.to_string())
}

#[tauri::command]
pub fn add_calendar_subscription(
    request: AddCalendarSubscriptionRequest,
) -> Result<CalendarSourceRecord, String> {
    let workspace_root = PathBuf::from(&request.workspace_root);
    let trimmed_url = request.url.trim();
    if trimmed_url.is_empty() {
        return Err("Subscription URL is required.".to_string());
    }

    if !(trimmed_url.starts_with("http://") || trimmed_url.starts_with("https://")) {
        return Err("Calendar subscriptions must use http:// or https:// URLs.".to_string());
    }

    store::add_subscription_source(
        &request.workspace_id,
        &workspace_root,
        request.name.trim(),
        trimmed_url,
    )
    .map_err(|error| error.to_string())
}

#[tauri::command]
pub fn remove_calendar_source(request: RemoveCalendarSourceRequest) -> Result<OperationAck, String> {
    let workspace_root = PathBuf::from(&request.workspace_root);
    let removed = store::remove_source(&workspace_root, &request.source_id)
        .map_err(|error| error.to_string())?;

    Ok(OperationAck {
        ok: true,
        message: if let Some(source) = removed {
            format!("Removed calendar source '{}'.", source.name)
        } else {
            "Calendar source was already removed.".to_string()
        },
    })
}

#[tauri::command]
pub fn load_calendar_source_snapshots(
    request: CalendarWorkspaceRequest,
) -> Result<Vec<CalendarSourceSnapshot>, String> {
    let workspace_root = PathBuf::from(&request.workspace_root);
    let mut sources = store::list_sources(&workspace_root).map_err(|error| error.to_string())?;
    sources.retain(|source| source.workspace_id == request.workspace_id);

    let client = Client::builder()
        .timeout(Duration::from_secs(15))
        .build()
        .map_err(|error| format!("Failed to create calendar HTTP client: {error}"))?;

    let mut snapshots = Vec::with_capacity(sources.len());

    for source in &mut sources {
        let snapshot = load_snapshot_for_source(source, &client);
        store::replace_source(&workspace_root, source).map_err(|error| error.to_string())?;
        snapshots.push(snapshot);
    }

    Ok(snapshots)
}

fn load_snapshot_for_source(
    source: &mut CalendarSourceRecord,
    client: &Client,
) -> CalendarSourceSnapshot {
    match source.kind {
        CalendarSourceKind::IcsImport => match store::read_source_content(source) {
            Ok(content) => CalendarSourceSnapshot {
                source: source.clone(),
                content: Some(content),
                fetched_at: now_iso(),
                stale: false,
                error: None,
            },
            Err(error) => {
                source.last_sync_error = Some(error.to_string());
                CalendarSourceSnapshot {
                    source: source.clone(),
                    content: None,
                    fetched_at: now_iso(),
                    stale: false,
                    error: Some(error.to_string()),
                }
            }
        },
        CalendarSourceKind::IcsSubscription => {
            let Some(url) = source.url.clone() else {
                let error = "Calendar subscription URL is missing.".to_string();
                source.last_sync_error = Some(error.clone());
                return CalendarSourceSnapshot {
                    source: source.clone(),
                    content: None,
                    fetched_at: now_iso(),
                    stale: false,
                    error: Some(error),
                };
            };

            match fetch_subscription_content(client, &url) {
                Ok(content) => {
                    source.last_synced_at = Some(now_iso());
                    source.last_sync_error = None;
                    let cache_write_error = store::write_source_content(source, &content)
                        .err()
                        .map(|error| error.to_string());
                    if let Some(error) = cache_write_error.clone() {
                        source.last_sync_error = Some(error);
                    }

                    CalendarSourceSnapshot {
                        source: source.clone(),
                        content: Some(content),
                        fetched_at: now_iso(),
                        stale: false,
                        error: cache_write_error,
                    }
                }
                Err(error) => {
                    let error_message = error.to_string();
                    source.last_sync_error = Some(error_message.clone());

                    match store::read_source_content(source) {
                        Ok(content) => CalendarSourceSnapshot {
                            source: source.clone(),
                            content: Some(content),
                            fetched_at: now_iso(),
                            stale: true,
                            error: Some(error_message),
                        },
                        Err(_) => CalendarSourceSnapshot {
                            source: source.clone(),
                            content: None,
                            fetched_at: now_iso(),
                            stale: false,
                            error: Some(error_message),
                        },
                    }
                }
            }
        }
    }
}

fn fetch_subscription_content(client: &Client, url: &str) -> Result<String, String> {
    let response = client
        .get(url)
        .header("User-Agent", "SkalaMeetingEngine/0.1")
        .send()
        .map_err(|error| format!("Failed to fetch '{url}': {error}"))?;
    let response = response
        .error_for_status()
        .map_err(|error| format!("Calendar subscription returned an error for '{url}': {error}"))?;
    response
        .text()
        .map_err(|error| format!("Failed to read calendar subscription body for '{url}': {error}"))
}
