use std::fs;
use std::path::{Path, PathBuf};

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

fn default_notes_dir(app: &AppHandle) -> Result<PathBuf, String> {
    app.path()
        .app_data_dir()
        .map_err(|error| format!("Failed to resolve app data directory: {}", error))
        .map(|path| path.join("documents").join("notes"))
}

fn resolve_notes_dir_from_root(
    default_notes_dir: &Path,
    base_path: Option<String>,
) -> Result<PathBuf, String> {
    let resolved_dir = match base_path {
        Some(path) if !path.trim().is_empty() => PathBuf::from(path.trim()),
        _ => default_notes_dir.to_path_buf(),
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

fn note_file_path_from_root(
    default_notes_dir: &Path,
    note_id: &str,
    base_path: Option<String>,
) -> Result<PathBuf, String> {
    let notes_dir = resolve_notes_dir_from_root(default_notes_dir, base_path)?;
    let file_name = format!("{}.md", sanitize_note_id(note_id));
    Ok(notes_dir.join(file_name))
}

fn note_file_path(
    app: &AppHandle,
    note_id: &str,
    base_path: Option<String>,
) -> Result<PathBuf, String> {
    note_file_path_from_root(&default_notes_dir(app)?, note_id, base_path)
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

#[tauri::command]
pub fn documents_resolve_note_path(
    app: AppHandle,
    note_id: String,
    base_path: Option<String>,
) -> Result<String, String> {
    let file_path = note_file_path(&app, &note_id, base_path)?;
    Ok(file_path.to_string_lossy().to_string())
}

#[cfg(test)]
mod tests {
    use std::time::{SystemTime, UNIX_EPOCH};

    use super::note_file_path_from_root;

    fn unique_temp_dir(label: &str) -> std::path::PathBuf {
        let suffix = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        std::env::temp_dir().join(format!("skala-documents-{label}-{suffix}"))
    }

    #[test]
    fn note_file_path_uses_default_notes_root_when_base_path_is_empty() {
        let default_root = unique_temp_dir("default-root");
        let file_path = note_file_path_from_root(&default_root, "product sync", None).unwrap();

        assert_eq!(file_path, default_root.join("product_sync.md"));
        assert!(default_root.exists());

        std::fs::remove_dir_all(default_root).unwrap();
    }

    #[test]
    fn note_file_path_prefers_explicit_base_path() {
        let default_root = unique_temp_dir("unused-default");
        let explicit_root = unique_temp_dir("explicit-root");
        let file_path = note_file_path_from_root(
            &default_root,
            "meeting/notes",
            Some(explicit_root.to_string_lossy().to_string()),
        )
        .unwrap();

        assert_eq!(file_path, explicit_root.join("meeting_notes.md"));
        assert!(explicit_root.exists());

        if default_root.exists() {
            std::fs::remove_dir_all(default_root).unwrap();
        }
        std::fs::remove_dir_all(explicit_root).unwrap();
    }
}
