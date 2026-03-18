use std::{
    collections::HashSet,
    fs,
    io::ErrorKind,
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
    list_runs_with_active_recordings(workspace_root, workspace_id, &HashSet::new())
}

pub fn list_runs_with_active_recordings(
    workspace_root: &Path,
    workspace_id: &str,
    active_recording_run_ids: &HashSet<String>,
) -> Result<Vec<MeetingRunRecord>> {
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
        let mut run: MeetingRunRecord = serde_json::from_str(&contents)?;
        if run.workspace_id == workspace_id {
            if run.status == MeetingRunStatus::Capturing
                && !active_recording_run_ids.contains(&run.id)
            {
                run.summary = Some("Recording interrupted before completion.".to_string());
                set_failed(
                    &mut run,
                    "Recording is no longer active. Start a new recording to continue.",
                );
                run.progress_label = Some("Recording interrupted".to_string());
                save_run(&run)?;
            }
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

pub fn transcript_artifact_kinds() -> [ArtifactKind; 3] {
    [
        ArtifactKind::RawTranscript,
        ArtifactKind::CleanedTranscript,
        ArtifactKind::ProviderResponse,
    ]
}

pub fn is_transcript_artifact_kind(kind: &ArtifactKind) -> bool {
    matches!(
        kind,
        ArtifactKind::RawTranscript
            | ArtifactKind::CleanedTranscript
            | ArtifactKind::ProviderResponse
    )
}

pub fn delete_transcript_artifacts(run: &mut MeetingRunRecord) -> Result<bool> {
    let transcript_artifacts = run
        .artifacts
        .iter()
        .filter(|artifact| is_transcript_artifact_kind(&artifact.kind))
        .cloned()
        .collect::<Vec<_>>();

    let removed_any = !transcript_artifacts.is_empty();

    for artifact in &transcript_artifacts {
        remove_file_if_exists(Path::new(&artifact.path))?;
    }

    run.artifacts
        .retain(|artifact| !is_transcript_artifact_kind(&artifact.kind));
    let remaining_ids = run
        .artifacts
        .iter()
        .map(|artifact| artifact.id.clone())
        .collect::<HashSet<_>>();
    run.artifact_ids
        .retain(|artifact_id| remaining_ids.contains(artifact_id));

    Ok(removed_any)
}

pub fn set_source_ready(run: &mut MeetingRunRecord) {
    run.status = MeetingRunStatus::SourceReady;
    run.summary = None;
    run.error_message = None;
    run.progress_label = Some("Ready to retranscribe".to_string());
    run.ended_at = Some(now_iso());
}

pub fn delete_run(workspace_root: &Path, run_id: &str) -> Result<bool> {
    remove_dir_if_exists(&run_root(workspace_root, run_id))
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

fn remove_file_if_exists(path: &Path) -> Result<()> {
    match fs::remove_file(path) {
        Ok(()) => Ok(()),
        Err(error) if error.kind() == ErrorKind::NotFound => Ok(()),
        Err(error) => Err(error).with_context(|| format!("Failed to delete '{}'.", path.display())),
    }
}

fn remove_dir_if_exists(path: &Path) -> Result<bool> {
    match fs::remove_dir_all(path) {
        Ok(()) => Ok(true),
        Err(error) if error.kind() == ErrorKind::NotFound => Ok(false),
        Err(error) => Err(error).with_context(|| format!("Failed to delete '{}'.", path.display())),
    }
}

#[cfg(test)]
mod tests {
    use std::{
        collections::HashSet,
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

    #[test]
    fn delete_run_removes_entire_run_directory() {
        let workspace_root = temp_workspace();
        let run = create_run(
            "ws-01",
            &workspace_root,
            "Delete run",
            MeetingRunType::MeetingRecording,
            MeetingRunStatus::NeedsReview,
            RecordingSource::Microphone,
        )
        .unwrap();

        let run_path = run_root(&workspace_root, &run.id);
        assert!(run_path.exists());

        let deleted = delete_run(&workspace_root, &run.id).unwrap();

        assert!(deleted);
        assert!(!run_path.exists());
    }

    #[test]
    fn delete_transcript_artifacts_removes_only_transcript_outputs() {
        let workspace_root = temp_workspace();
        let mut run = create_run(
            "ws-01",
            &workspace_root,
            "Delete transcript artifacts",
            MeetingRunType::MeetingRecording,
            MeetingRunStatus::NeedsReview,
            RecordingSource::Microphone,
        )
        .unwrap();

        let recording_path = run_input_dir(&workspace_root, &run.id).join("recording.wav");
        fs::write(&recording_path, b"audio").unwrap();
        add_artifact(
            &mut run,
            ArtifactKind::RawRecording,
            recording_path.to_string_lossy().to_string(),
            Some("Recording output".to_string()),
        );

        let log_path = run_artifacts_dir(&workspace_root, &run.id).join("recording.log");
        fs::write(&log_path, b"log").unwrap();
        add_artifact(
            &mut run,
            ArtifactKind::TerminalLog,
            log_path.to_string_lossy().to_string(),
            Some("Recording log".to_string()),
        );

        let raw_path = run_artifacts_dir(&workspace_root, &run.id).join("transcript-raw.txt");
        fs::write(&raw_path, "raw transcript").unwrap();
        add_artifact(
            &mut run,
            ArtifactKind::RawTranscript,
            raw_path.to_string_lossy().to_string(),
            Some("Raw transcript".to_string()),
        );

        let cleaned_path =
            run_artifacts_dir(&workspace_root, &run.id).join("transcript-cleaned.md");
        fs::write(&cleaned_path, "# cleaned").unwrap();
        add_artifact(
            &mut run,
            ArtifactKind::CleanedTranscript,
            cleaned_path.to_string_lossy().to_string(),
            Some("Cleaned transcript".to_string()),
        );

        let provider_path = run_artifacts_dir(&workspace_root, &run.id)
            .join("transcription-provider-response.json");
        fs::write(&provider_path, "{}\n").unwrap();
        add_artifact(
            &mut run,
            ArtifactKind::ProviderResponse,
            provider_path.to_string_lossy().to_string(),
            Some("OpenAI transcription response".to_string()),
        );

        let removed_any = delete_transcript_artifacts(&mut run).unwrap();

        assert!(removed_any);
        assert!(recording_path.exists());
        assert!(log_path.exists());
        assert!(!raw_path.exists());
        assert!(!cleaned_path.exists());
        assert!(!provider_path.exists());
        assert_eq!(run.artifacts.len(), 2);
        assert!(run.artifacts.iter().all(|artifact| {
            matches!(
                artifact.kind,
                ArtifactKind::RawRecording | ArtifactKind::TerminalLog
            )
        }));
        assert_eq!(run.artifact_ids.len(), 2);
    }

    #[test]
    fn delete_transcript_artifacts_ignores_missing_files() {
        let workspace_root = temp_workspace();
        let mut run = create_run(
            "ws-01",
            &workspace_root,
            "Missing transcript files",
            MeetingRunType::MeetingRecording,
            MeetingRunStatus::NeedsReview,
            RecordingSource::Microphone,
        )
        .unwrap();

        let raw_path = run_artifacts_dir(&workspace_root, &run.id).join("transcript-raw.txt");
        add_artifact(
            &mut run,
            ArtifactKind::RawTranscript,
            raw_path.to_string_lossy().to_string(),
            Some("Raw transcript".to_string()),
        );

        let removed_any = delete_transcript_artifacts(&mut run).unwrap();

        assert!(removed_any);
        assert!(run.artifacts.is_empty());
        assert!(run.artifact_ids.is_empty());
    }

    #[test]
    fn marks_stale_capturing_runs_as_failed_when_not_active() {
        let workspace_root = temp_workspace();
        let run = create_run(
            "ws-01",
            &workspace_root,
            "Interrupted capture",
            MeetingRunType::MeetingRecording,
            MeetingRunStatus::Capturing,
            RecordingSource::Microphone,
        )
        .unwrap();

        let runs =
            list_runs_with_active_recordings(&workspace_root, "ws-01", &HashSet::new()).unwrap();
        let refreshed = runs.into_iter().find(|item| item.id == run.id).unwrap();

        assert_eq!(refreshed.status, MeetingRunStatus::Failed);
        assert_eq!(
            refreshed.progress_label.as_deref(),
            Some("Recording interrupted")
        );
        assert_eq!(
            refreshed.summary.as_deref(),
            Some("Recording interrupted before completion.")
        );
    }

    #[test]
    fn keeps_active_capturing_runs_when_session_is_known() {
        let workspace_root = temp_workspace();
        let run = create_run(
            "ws-01",
            &workspace_root,
            "Live capture",
            MeetingRunType::MeetingRecording,
            MeetingRunStatus::Capturing,
            RecordingSource::Microphone,
        )
        .unwrap();

        let active_run_ids = HashSet::from([run.id.clone()]);
        let runs =
            list_runs_with_active_recordings(&workspace_root, "ws-01", &active_run_ids).unwrap();
        let refreshed = runs.into_iter().find(|item| item.id == run.id).unwrap();

        assert_eq!(refreshed.status, MeetingRunStatus::Capturing);
    }
}
