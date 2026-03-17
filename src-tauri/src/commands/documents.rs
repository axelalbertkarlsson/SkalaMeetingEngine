use std::fs;
use std::path::PathBuf;

use tauri::{AppHandle, Manager};

fn sanitize_note_id(note_id: &str) -> String {
    let sanitized: String = note_id
        .chars()
        .map(|char_value| {
            if char_value.is_ascii_alphanumeric() || char_value == '-' || char_value == '_' {
                char_value
            } else {
                '_'
            }
        })
        .collect();

    if sanitized.is_empty() {
        "note".to_string()
    } else {
        sanitized
    }
}

fn resolve_notes_dir(app: &AppHandle, base_path: Option<String>) -> Result<PathBuf, String> {
    let resolved_dir = match base_path {
        Some(path) if !path.trim().is_empty() => PathBuf::from(path.trim()),
        _ => app
            .path()
            .app_data_dir()
            .map_err(|error| format!("Failed to resolve app data directory: {}", error))?
            .join("documents")
            .join("notes"),
    };

    fs::create_dir_all(&resolved_dir).map_err(|error| {
        format!(
            "Failed to create notes directory '{}': {}",
            resolved_dir.display(),
            error
        )
    })?;

    Ok(resolved_dir)
}

fn note_file_path(
    app: &AppHandle,
    note_id: &str,
    base_path: Option<String>,
) -> Result<PathBuf, String> {
    let notes_dir = resolve_notes_dir(app, base_path)?;
    let file_name = format!("{}.md", sanitize_note_id(note_id));
    Ok(notes_dir.join(file_name))
}

#[tauri::command]
pub fn documents_read_note(
    app: AppHandle,
    note_id: String,
    base_path: Option<String>,
) -> Result<Option<String>, String> {
    let file_path = note_file_path(&app, &note_id, base_path)?;

    if !file_path.exists() {
        return Ok(None);
    }

    fs::read_to_string(&file_path).map(Some).map_err(|error| {
        format!(
            "Failed to read note file '{}': {}",
            file_path.display(),
            error
        )
    })
}

#[tauri::command]
pub fn documents_write_note(
    app: AppHandle,
    note_id: String,
    content: String,
    base_path: Option<String>,
) -> Result<(), String> {
    let file_path = note_file_path(&app, &note_id, base_path)?;

    fs::write(&file_path, content).map_err(|error| {
        format!(
            "Failed to write note file '{}': {}",
            file_path.display(),
            error
        )
    })
}

#[tauri::command]
pub fn documents_delete_note(
    app: AppHandle,
    note_id: String,
    base_path: Option<String>,
) -> Result<(), String> {
    let file_path = note_file_path(&app, &note_id, base_path)?;

    if !file_path.exists() {
        return Ok(());
    }

    fs::remove_file(&file_path).map_err(|error| {
        format!(
            "Failed to delete note file '{}': {}",
            file_path.display(),
            error
        )
    })
}

#[tauri::command]
pub fn documents_copy_note(
    app: AppHandle,
    source_note_id: String,
    target_note_id: String,
    base_path: Option<String>,
) -> Result<(), String> {
    let source_path = note_file_path(&app, &source_note_id, base_path.clone())?;
    let target_path = note_file_path(&app, &target_note_id, base_path)?;

    if source_path.exists() {
        fs::copy(&source_path, &target_path).map_err(|error| {
            format!(
                "Failed to copy note file from '{}' to '{}': {}",
                source_path.display(),
                target_path.display(),
                error
            )
        })?;
    } else {
        fs::write(&target_path, "").map_err(|error| {
            format!(
                "Failed to initialize copied note file '{}': {}",
                target_path.display(),
                error
            )
        })?;
    }

    Ok(())
}
