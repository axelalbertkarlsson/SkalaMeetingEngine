use std::{
    fs,
    path::{Path, PathBuf},
};

use anyhow::{Context, Result};

use super::models::{
    now_iso, ArtifactKind, ArtifactRecord, MeetingRunRecord, MeetingRunStatus, MeetingRunType,
    RecordingSource,
};

pub fn app_root(workspace_root: &Path) -> PathBuf {
    workspace_root.join(".skala-meeting-engine")
}

pub fn runs_root(workspace_root: &Path) -> PathBuf {
    app_root(workspace_root).join("runs")
}

pub fn ensure_workspace_dirs(workspace_root: &Path) -> Result<()> {
    fs::create_dir_all(runs_root(workspace_root)).with_context(|| {
        format!(
            "Failed to create meeting run directory under '{}'.",
            workspace_root.display()
        )
    })?;
    Ok(())
}

pub fn run_root(workspace_root: &Path, run_id: &str) -> PathBuf {
    runs_root(workspace_root).join(run_id)
}

pub fn run_input_dir(workspace_root: &Path, run_id: &str) -> PathBuf {
    run_root(workspace_root, run_id).join("input")
}

pub fn run_artifacts_dir(workspace_root: &Path, run_id: &str) -> PathBuf {
    run_root(workspace_root, run_id).join("artifacts")
}

fn run_manifest_path(workspace_root: &Path, run_id: &str) -> PathBuf {
    run_root(workspace_root, run_id).join("run.json")
}

pub fn prepare_run_dirs(workspace_root: &Path, run_id: &str) -> Result<()> {
    fs::create_dir_all(run_input_dir(workspace_root, run_id))?;
    fs::create_dir_all(run_artifacts_dir(workspace_root, run_id))?;
    Ok(())
}

pub fn create_run(
    workspace_id: &str,
    workspace_root: &Path,
    title: &str,
    run_type: MeetingRunType,
    status: MeetingRunStatus,
    recording_source: RecordingSource,
) -> Result<MeetingRunRecord> {
    ensure_workspace_dirs(workspace_root)?;
    let run = MeetingRunRecord::new(
        workspace_id.to_string(),
        workspace_root.to_string_lossy().to_string(),
        title.trim().to_string(),
        run_type,
        status,
        recording_source,
    );
    prepare_run_dirs(workspace_root, &run.id)?;
    save_run(&run)?;
    Ok(run)
}

pub fn save_run(run: &MeetingRunRecord) -> Result<()> {
    let workspace_root = PathBuf::from(&run.workspace_root);
    prepare_run_dirs(&workspace_root, &run.id)?;
    let manifest_path = run_manifest_path(&workspace_root, &run.id);
    let serialized = serde_json::to_string_pretty(run)?;
    fs::write(&manifest_path, serialized)
        .with_context(|| format!("Failed to save run manifest '{}'.", manifest_path.display()))?;
    Ok(())
}

pub fn load_run(workspace_root: &Path, run_id: &str) -> Result<MeetingRunRecord> {
    let manifest_path = run_manifest_path(workspace_root, run_id);
    let contents = fs::read_to_string(&manifest_path)
        .with_context(|| format!("Failed to read '{}'.", manifest_path.display()))?;
    let run = serde_json::from_str(&contents)
        .with_context(|| format!("Failed to parse '{}'.", manifest_path.display()))?;
    Ok(run)
}

pub fn list_runs(workspace_root: &Path, workspace_id: &str) -> Result<Vec<MeetingRunRecord>> {
    ensure_workspace_dirs(workspace_root)?;
    let mut runs = Vec::new();

    for entry in fs::read_dir(runs_root(workspace_root))? {
        let entry = entry?;
        if !entry.file_type()?.is_dir() {
            continue;
        }

        let manifest_path = entry.path().join("run.json");
        if !manifest_path.exists() {
            continue;
        }

        let contents = fs::read_to_string(&manifest_path)?;
        let run: MeetingRunRecord = serde_json::from_str(&contents)?;
        if run.workspace_id == workspace_id {
            runs.push(run);
        }
    }

    runs.sort_by(|left, right| right.started_at.cmp(&left.started_at));
    Ok(runs)
}

pub fn add_artifact(
    run: &mut MeetingRunRecord,
    kind: ArtifactKind,
    path: impl Into<String>,
    label: Option<String>,
) -> ArtifactRecord {
    let artifact = ArtifactRecord {
        id: format!("artifact-{}", uuid::Uuid::new_v4()),
        run_id: run.id.clone(),
        kind,
        path: path.into(),
        created_at: now_iso(),
        label,
    };
    run.artifact_ids.push(artifact.id.clone());
    run.artifacts.push(artifact.clone());
    artifact
}

pub fn write_input_bytes(
    workspace_root: &Path,
    run_id: &str,
    file_name: &str,
    bytes: &[u8],
) -> Result<PathBuf> {
    let input_dir = run_input_dir(workspace_root, run_id);
    fs::create_dir_all(&input_dir)?;
    let sanitized_name = sanitize_file_name(file_name);
    let target_path = input_dir.join(sanitized_name);
    fs::write(&target_path, bytes)
        .with_context(|| format!("Failed to write '{}'.", target_path.display()))?;
    Ok(target_path)
}

pub fn sanitize_file_name(file_name: &str) -> String {
    file_name
        .chars()
        .map(|ch| match ch {
            '/' | '\\' | ':' | '*' | '?' | '"' | '<' | '>' | '|' => '_',
            _ => ch,
        })
        .collect()
}

pub fn set_failed(run: &mut MeetingRunRecord, message: impl Into<String>) {
    run.status = MeetingRunStatus::Failed;
    run.error_message = Some(message.into());
    run.progress_label = Some("Workflow failed".to_string());
    run.ended_at = Some(now_iso());
}

pub fn set_needs_review(run: &mut MeetingRunRecord, summary: impl Into<String>) {
    run.status = MeetingRunStatus::NeedsReview;
    run.summary = Some(summary.into());
    run.error_message = None;
    run.progress_label = Some("Transcripts ready for review".to_string());
    run.ended_at = Some(now_iso());
}

#[cfg(test)]
mod tests {
    use std::{
        env, fs,
        time::{SystemTime, UNIX_EPOCH},
    };

    use super::*;

    fn temp_workspace() -> PathBuf {
        let unique = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        let path = env::temp_dir().join(format!("skala-meeting-store-test-{unique}"));
        fs::create_dir_all(&path).unwrap();
        path
    }

    #[test]
    fn persists_and_loads_run_manifest() {
        let workspace_root = temp_workspace();
        let mut run = create_run(
            "ws-01",
            &workspace_root,
            "Transcript test",
            MeetingRunType::MeetingImport,
            MeetingRunStatus::Imported,
            RecordingSource::ImportedFile,
        )
        .unwrap();
        add_artifact(
            &mut run,
            ArtifactKind::RawRecording,
            workspace_root
                .join("audio.wav")
                .to_string_lossy()
                .to_string(),
            None,
        );
        save_run(&run).unwrap();

        let loaded = load_run(&workspace_root, &run.id).unwrap();
        assert_eq!(loaded.id, run.id);
        assert_eq!(loaded.artifacts.len(), 1);
        assert_eq!(loaded.status, MeetingRunStatus::Imported);
    }

    #[test]
    fn writes_imported_bytes_to_run_input_directory() {
        let workspace_root = temp_workspace();
        let run = create_run(
            "ws-01",
            &workspace_root,
            "Bytes test",
            MeetingRunType::MeetingImport,
            MeetingRunStatus::Imported,
            RecordingSource::ImportedFile,
        )
        .unwrap();
        let input_path =
            write_input_bytes(&workspace_root, &run.id, "meeting?.wav", &[1, 2, 3]).unwrap();
        assert!(input_path.exists());
        assert_eq!(fs::read(input_path).unwrap(), vec![1, 2, 3]);
    }
}
