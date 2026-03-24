use std::{
    fs,
    io::ErrorKind,
    path::{Path, PathBuf},
};

use anyhow::{Context, Result};

use super::models::{CalendarSourceKind, CalendarSourceRecord};

pub fn calendar_root(workspace_root: &Path) -> PathBuf {
    crate::meetings::store::app_root(workspace_root).join("calendar")
}

pub fn imports_root(workspace_root: &Path) -> PathBuf {
    calendar_root(workspace_root).join("imports")
}

pub fn cache_root(workspace_root: &Path) -> PathBuf {
    calendar_root(workspace_root).join("cache")
}

fn sources_manifest_path(workspace_root: &Path) -> PathBuf {
    calendar_root(workspace_root).join("sources.json")
}

pub fn ensure_calendar_dirs(workspace_root: &Path) -> Result<()> {
    fs::create_dir_all(imports_root(workspace_root)).with_context(|| {
        format!(
            "Failed to create imported calendar directory under '{}'.",
            workspace_root.display()
        )
    })?;
    fs::create_dir_all(cache_root(workspace_root)).with_context(|| {
        format!(
            "Failed to create cached calendar directory under '{}'.",
            workspace_root.display()
        )
    })?;
    Ok(())
}

pub fn list_sources(workspace_root: &Path) -> Result<Vec<CalendarSourceRecord>> {
    ensure_calendar_dirs(workspace_root)?;
    let manifest_path = sources_manifest_path(workspace_root);
    if !manifest_path.exists() {
        return Ok(Vec::new());
    }

    let contents = fs::read_to_string(&manifest_path)
        .with_context(|| format!("Failed to read '{}'.", manifest_path.display()))?;
    let sources = serde_json::from_str::<Vec<CalendarSourceRecord>>(&contents)
        .with_context(|| format!("Failed to parse '{}'.", manifest_path.display()))?;
    Ok(sources)
}

pub fn save_sources(workspace_root: &Path, sources: &[CalendarSourceRecord]) -> Result<()> {
    ensure_calendar_dirs(workspace_root)?;
    let manifest_path = sources_manifest_path(workspace_root);
    let serialized = serde_json::to_string_pretty(sources)?;
    fs::write(&manifest_path, serialized)
        .with_context(|| format!("Failed to write '{}'.", manifest_path.display()))?;
    Ok(())
}

pub fn import_source(
    workspace_id: &str,
    workspace_root: &Path,
    name: &str,
    file_name: &str,
    file_bytes: &[u8],
) -> Result<CalendarSourceRecord> {
    ensure_calendar_dirs(workspace_root)?;

    let sanitized_name = crate::meetings::store::sanitize_file_name(file_name);
    let stored_path = imports_root(workspace_root)
        .join(format!("{}-{}", uuid::Uuid::new_v4(), sanitized_name));
    fs::write(&stored_path, file_bytes)
        .with_context(|| format!("Failed to write '{}'.", stored_path.display()))?;

    let source = CalendarSourceRecord::new(
        workspace_id.to_string(),
        workspace_root.to_string_lossy().to_string(),
        CalendarSourceKind::IcsImport,
        name.trim().to_string(),
        None,
        Some(file_name.trim().to_string()),
        stored_path.to_string_lossy().to_string(),
    );

    let mut sources = list_sources(workspace_root)?;
    sources.push(source.clone());
    save_sources(workspace_root, &sources)?;
    Ok(source)
}

pub fn add_subscription_source(
    workspace_id: &str,
    workspace_root: &Path,
    name: &str,
    url: &str,
) -> Result<CalendarSourceRecord> {
    ensure_calendar_dirs(workspace_root)?;

    let trimmed_url = url.trim().to_string();
    let source = CalendarSourceRecord::new(
        workspace_id.to_string(),
        workspace_root.to_string_lossy().to_string(),
        CalendarSourceKind::IcsSubscription,
        name.trim().to_string(),
        Some(trimmed_url),
        None,
        cache_root(workspace_root)
            .join(format!("{}.ics", uuid::Uuid::new_v4()))
            .to_string_lossy()
            .to_string(),
    );

    let mut sources = list_sources(workspace_root)?;
    sources.push(source.clone());
    save_sources(workspace_root, &sources)?;
    Ok(source)
}

pub fn replace_source(workspace_root: &Path, source: &CalendarSourceRecord) -> Result<()> {
    let mut sources = list_sources(workspace_root)?;
    if let Some(index) = sources.iter().position(|item| item.id == source.id) {
        sources[index] = source.clone();
    } else {
        sources.push(source.clone());
    }
    save_sources(workspace_root, &sources)
}

pub fn remove_source(workspace_root: &Path, source_id: &str) -> Result<Option<CalendarSourceRecord>> {
    let mut sources = list_sources(workspace_root)?;
    let Some(index) = sources.iter().position(|source| source.id == source_id) else {
        return Ok(None);
    };

    let removed = sources.remove(index);
    save_sources(workspace_root, &sources)?;

    match fs::remove_file(&removed.stored_path) {
        Ok(()) => {}
        Err(error) if error.kind() == ErrorKind::NotFound => {}
        Err(error) => {
            return Err(error).with_context(|| {
                format!(
                    "Failed to delete stored calendar data '{}'.",
                    removed.stored_path
                )
            });
        }
    }

    Ok(Some(removed))
}

pub fn read_source_content(source: &CalendarSourceRecord) -> Result<String> {
    fs::read_to_string(&source.stored_path).with_context(|| {
        format!(
            "Failed to read calendar source data '{}'.",
            source.stored_path
        )
    })
}

pub fn write_source_content(source: &CalendarSourceRecord, content: &str) -> Result<()> {
    let path = PathBuf::from(&source.stored_path);
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent)?;
    }
    fs::write(&path, content)
        .with_context(|| format!("Failed to write calendar cache '{}'.", path.display()))?;
    Ok(())
}
