use std::{fs, path::PathBuf};

use anyhow::{Context, Result};

use super::models::TranscriptionSettings;

fn settings_root() -> Result<PathBuf> {
    let current_dir =
        std::env::current_dir().context("Failed to resolve current working directory.")?;
    Ok(current_dir.join(".skala-meeting-engine").join("settings"))
}

fn settings_path() -> Result<PathBuf> {
    Ok(settings_root()?.join("transcription.json"))
}

pub fn load_settings() -> Result<TranscriptionSettings> {
    let path = settings_path()?;
    if !path.exists() {
        return Ok(TranscriptionSettings::default());
    }

    let contents = fs::read_to_string(&path)
        .with_context(|| format!("Failed to read '{}'.", path.display()))?;
    let settings: TranscriptionSettings = serde_json::from_str(&contents)
        .with_context(|| format!("Failed to parse '{}'.", path.display()))?;
    Ok(settings)
}

pub fn save_settings(settings: &TranscriptionSettings) -> Result<TranscriptionSettings> {
    let path = settings_path()?;
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent)?;
    }

    let serialized = serde_json::to_string_pretty(settings)?;
    fs::write(&path, serialized)
        .with_context(|| format!("Failed to save '{}'.", path.display()))?;
    Ok(settings.clone())
}
