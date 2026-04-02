use std::fs;
use std::hash::{Hash, Hasher};
use std::path::{Path, PathBuf};

use serde::Serialize;
use tauri::{AppHandle, Manager};

const MAX_CODEX_CONTEXT_CONTENT_CHARS: usize = 24_000;
const CODEX_CONTEXT_TRUNCATION_NOTICE: &str = "\n\n[truncated for Codex context]";

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

fn sanitize_file_name_fragment(value: &str) -> String {
    let sanitized: String = value
        .chars()
        .map(|char_value| {
            if char_value.is_ascii_alphanumeric() || char_value == '-' || char_value == '_' {
                char_value
            } else {
                '_'
            }
        })
        .collect();

    let trimmed = sanitized.trim_matches('_');
    if trimmed.is_empty() {
        "context".to_string()
    } else {
        trimmed.to_string()
    }
}

fn canonicalize_path(path: &Path, label: &str) -> Result<PathBuf, String> {
    fs::canonicalize(path).map_err(|error| {
        format!(
            "Failed to resolve {} '{}': {}",
            label,
            path.display(),
            error
        )
    })
}

fn codex_context_dir(workspace_root: &Path) -> Result<PathBuf, String> {
    let directory = workspace_root.join(".skala").join("codex-context");
    fs::create_dir_all(&directory).map_err(|error| {
        format!(
            "Failed to create Codex context staging directory '{}': {}",
            directory.display(),
            error
        )
    })?;
    Ok(directory)
}

fn resolve_source_file_for_workspace(
    workspace_root: &Path,
    source_path: &str,
) -> Result<PathBuf, String> {
    let trimmed_source_path = source_path.trim();
    if trimmed_source_path.is_empty() {
        return Err("Cannot stage an empty source path for Codex.".to_string());
    }

    let raw_path = PathBuf::from(trimmed_source_path);
    let resolved_path = if raw_path.is_absolute() {
        raw_path
    } else {
        workspace_root.join(raw_path)
    };

    if !resolved_path.exists() {
        return Err(format!(
            "Cannot stage '{}' for Codex because the file does not exist.",
            resolved_path.display()
        ));
    }

    if !resolved_path.is_file() {
        return Err(format!(
            "Cannot stage '{}' for Codex because it is not a file.",
            resolved_path.display()
        ));
    }

    canonicalize_path(&resolved_path, "Codex context file")
}

fn staged_context_file_path(
    workspace_root: &Path,
    canonical_source_path: &Path,
) -> Result<PathBuf, String> {
    let staging_directory = codex_context_dir(workspace_root)?;
    let source_stem = canonical_source_path
        .file_stem()
        .and_then(|value| value.to_str())
        .map(sanitize_file_name_fragment)
        .unwrap_or_else(|| "context".to_string());
    let source_extension = canonical_source_path
        .extension()
        .and_then(|value| value.to_str())
        .map(sanitize_file_name_fragment)
        .filter(|value| !value.is_empty());
    let mut hasher = std::collections::hash_map::DefaultHasher::new();
    canonical_source_path.to_string_lossy().hash(&mut hasher);
    let suffix = format!("{:016x}", hasher.finish());
    let file_name = match source_extension {
        Some(extension) => format!("{}-{}.{}", source_stem, suffix, extension),
        None => format!("{}-{}", source_stem, suffix),
    };

    Ok(staging_directory.join(file_name))
}

fn stage_file_for_codex_from_workspace_root(
    workspace_root: &Path,
    source_path: &str,
) -> Result<PathBuf, String> {
    let canonical_workspace_root = canonicalize_path(workspace_root, "workspace root")?;
    let canonical_source_path = resolve_source_file_for_workspace(&canonical_workspace_root, source_path)?;

    if canonical_source_path.starts_with(&canonical_workspace_root) {
        return Ok(canonical_source_path);
    }

    let staged_path = staged_context_file_path(&canonical_workspace_root, &canonical_source_path)?;
    fs::copy(&canonical_source_path, &staged_path).map_err(|error| {
        format!(
            "Failed to copy Codex context file from '{}' to '{}': {}",
            canonical_source_path.display(),
            staged_path.display(),
            error
        )
    })?;

    Ok(staged_path)
}

fn normalize_codex_display_path(path: &Path) -> String {
    let raw = path.to_string_lossy().to_string();
    raw.strip_prefix(r"\\?\").unwrap_or(&raw).to_string()
}

fn read_file_for_codex_context(path: &Path) -> Result<String, String> {
    let bytes = fs::read(path).map_err(|error| {
        format!(
            "Failed to read Codex context file '{}': {}",
            path.display(),
            error
        )
    })?;
    let mut content = String::from_utf8_lossy(&bytes).into_owned();
    if content.chars().count() > MAX_CODEX_CONTEXT_CONTENT_CHARS {
        content = content
            .chars()
            .take(MAX_CODEX_CONTEXT_CONTENT_CHARS)
            .collect::<String>();
        content.push_str(CODEX_CONTEXT_TRUNCATION_NOTICE);
    }
    Ok(content)
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CodexPreparedFile {
    path: String,
    content: String,
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

#[tauri::command]
pub fn documents_stage_file_for_codex(
    workspace_root: String,
    source_path: String,
) -> Result<String, String> {
    let staged_path =
        stage_file_for_codex_from_workspace_root(Path::new(&workspace_root), &source_path)?;
    Ok(normalize_codex_display_path(&staged_path))
}

#[tauri::command]
pub fn documents_prepare_file_for_codex(
    workspace_root: String,
    source_path: String,
) -> Result<CodexPreparedFile, String> {
    let staged_path =
        stage_file_for_codex_from_workspace_root(Path::new(&workspace_root), &source_path)?;
    let content = read_file_for_codex_context(&staged_path)?;

    Ok(CodexPreparedFile {
        path: normalize_codex_display_path(&staged_path),
        content,
    })
}

#[cfg(test)]
mod tests {
    use std::time::{SystemTime, UNIX_EPOCH};

    use super::{note_file_path_from_root, stage_file_for_codex_from_workspace_root};

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

    #[test]
    fn stage_file_for_codex_keeps_workspace_local_files_in_place() {
        let workspace_root = unique_temp_dir("workspace-local");
        std::fs::create_dir_all(&workspace_root).unwrap();
        let file_path = workspace_root.join("notes").join("decision-log.md");
        std::fs::create_dir_all(file_path.parent().unwrap()).unwrap();
        std::fs::write(&file_path, "# Decision log").unwrap();

        let staged_path = stage_file_for_codex_from_workspace_root(
            &workspace_root,
            &file_path.to_string_lossy(),
        )
        .unwrap();

        assert_eq!(staged_path, std::fs::canonicalize(&file_path).unwrap());

        std::fs::remove_dir_all(workspace_root).unwrap();
    }

    #[test]
    fn stage_file_for_codex_copies_external_files_into_workspace_context_dir() {
        let workspace_root = unique_temp_dir("workspace-staging");
        let external_root = unique_temp_dir("workspace-external");
        std::fs::create_dir_all(&workspace_root).unwrap();
        std::fs::create_dir_all(&external_root).unwrap();
        let external_file_path = external_root.join("meeting note.md");
        std::fs::write(&external_file_path, "External note").unwrap();

        let staged_path = stage_file_for_codex_from_workspace_root(
            &workspace_root,
            &external_file_path.to_string_lossy(),
        )
        .unwrap();

        let canonical_workspace_root = std::fs::canonicalize(&workspace_root).unwrap();
        assert!(staged_path.starts_with(canonical_workspace_root.join(".skala").join("codex-context")));
        assert_eq!(std::fs::read_to_string(&staged_path).unwrap(), "External note");

        std::fs::remove_dir_all(workspace_root).unwrap();
        std::fs::remove_dir_all(external_root).unwrap();
    }
}
