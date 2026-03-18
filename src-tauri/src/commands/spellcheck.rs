use std::{collections::BTreeSet, fs, path::PathBuf};

use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Manager};

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PersonalDictionary {
    pub version: u8,
    pub words: Vec<String>,
}

impl Default for PersonalDictionary {
    fn default() -> Self {
        Self {
            version: 1,
            words: Vec::new(),
        }
    }
}

fn normalize_word(word: &str) -> String {
    word.trim().to_lowercase()
}

fn dictionary_path(app: &AppHandle) -> Result<PathBuf, String> {
    let settings_dir = app
        .path()
        .app_data_dir()
        .map_err(|error| format!("Failed to resolve app data directory: {}", error))?
        .join("settings");

    fs::create_dir_all(&settings_dir).map_err(|error| {
        format!(
            "Failed to create spellcheck settings directory '{}': {}",
            settings_dir.display(),
            error
        )
    })?;

    Ok(settings_dir.join("spellcheck-user-dictionary.json"))
}

fn sanitize_dictionary(dictionary: PersonalDictionary) -> PersonalDictionary {
    let words = dictionary
        .words
        .into_iter()
        .map(|word| normalize_word(&word))
        .filter(|word| !word.is_empty())
        .collect::<BTreeSet<_>>()
        .into_iter()
        .collect();

    PersonalDictionary { version: 1, words }
}

fn load_dictionary(app: &AppHandle) -> Result<PersonalDictionary, String> {
    let path = dictionary_path(app)?;
    if !path.exists() {
        return Ok(PersonalDictionary::default());
    }

    let contents = fs::read_to_string(&path).map_err(|error| {
        format!(
            "Failed to read spellcheck dictionary '{}': {}",
            path.display(),
            error
        )
    })?;

    let dictionary = serde_json::from_str::<PersonalDictionary>(&contents).map_err(|error| {
        format!(
            "Failed to parse spellcheck dictionary '{}': {}",
            path.display(),
            error
        )
    })?;

    Ok(sanitize_dictionary(dictionary))
}

fn save_dictionary(app: &AppHandle, dictionary: &PersonalDictionary) -> Result<PersonalDictionary, String> {
    let path = dictionary_path(app)?;
    let sanitized = sanitize_dictionary(dictionary.clone());
    let serialized = serde_json::to_string_pretty(&sanitized).map_err(|error| {
        format!(
            "Failed to serialize spellcheck dictionary '{}': {}",
            path.display(),
            error
        )
    })?;

    fs::write(&path, serialized).map_err(|error| {
        format!(
            "Failed to write spellcheck dictionary '{}': {}",
            path.display(),
            error
        )
    })?;

    Ok(sanitized)
}

#[tauri::command]
pub fn spellcheck_load_personal_dictionary(app: AppHandle) -> Result<PersonalDictionary, String> {
    load_dictionary(&app)
}

#[tauri::command]
pub fn spellcheck_add_personal_word(
    app: AppHandle,
    word: String,
) -> Result<PersonalDictionary, String> {
    let normalized = normalize_word(&word);
    if normalized.is_empty() {
        return Err("Cannot add an empty word to the spellcheck dictionary.".to_string());
    }

    let mut dictionary = load_dictionary(&app)?;
    dictionary.words.push(normalized);
    save_dictionary(&app, &dictionary)
}

#[tauri::command]
pub fn spellcheck_remove_personal_word(
    app: AppHandle,
    word: String,
) -> Result<PersonalDictionary, String> {
    let normalized = normalize_word(&word);
    let mut dictionary = load_dictionary(&app)?;
    dictionary.words.retain(|entry| entry != &normalized);
    save_dictionary(&app, &dictionary)
}