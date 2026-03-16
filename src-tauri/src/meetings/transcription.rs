use anyhow::{anyhow, Context, Result};
use reqwest::blocking::{multipart, Client};
use serde_json::{json, Value};
use std::{
    fs,
    io::ErrorKind,
    path::{Path, PathBuf},
    process::Command,
};

use super::{
    models::{ArtifactKind, MeetingRunStatus, TranscriptionSettings},
    settings,
    store::{self, load_run, run_artifacts_dir, save_run, set_failed, set_needs_review},
};

const OPENAI_AUDIO_TRANSCRIPTIONS_URL: &str = "https://api.openai.com/v1/audio/transcriptions";
const OPENAI_RESPONSES_URL: &str = "https://api.openai.com/v1/responses";
const OPENAI_FILE_SIZE_LIMIT_BYTES: u64 = 24 * 1024 * 1024;

pub fn enqueue_transcription(workspace_root: PathBuf, run_id: String) {
    std::thread::spawn(move || {
        if let Err(error) = run_transcription_pipeline(&workspace_root, &run_id) {
            if let Ok(mut run) = load_run(&workspace_root, &run_id) {
                set_failed(&mut run, error.to_string());
                let _ = save_run(&run);
            }
        }
    });
}

pub fn run_transcription_pipeline(workspace_root: &Path, run_id: &str) -> Result<()> {
    let settings = settings::load_settings()?;
    let api_key = resolve_api_key(&settings)?;
    let client = Client::new();

    let mut run = load_run(workspace_root, run_id)?;
    run.status = MeetingRunStatus::Transcribing;
    run.error_message = None;
    run.progress_label = Some("Uploading audio to OpenAI".to_string());
    save_run(&run)?;

    let input_path = run
        .input_path
        .as_deref()
        .map(PathBuf::from)
        .ok_or_else(|| anyhow!("Run '{}' has no input file to transcribe.", run_id))?;

    let prepared_inputs = prepare_inputs(workspace_root, run_id, &input_path, &settings)?;
    let mut chunk_responses = Vec::new();
    let mut chunk_texts = Vec::new();

    for prepared in &prepared_inputs {
        let response = transcribe_file(&client, prepared, &settings, &api_key)?;
        let transcript_text = extract_transcript_text(&response, settings.diarization_enabled)
            .ok_or_else(|| {
                anyhow!("OpenAI transcription response did not contain transcript text.")
            })?;

        chunk_texts.push(transcript_text);
        chunk_responses.push(response);
    }

    let raw_transcript = stitch_transcripts(&chunk_texts);
    let artifacts_dir = run_artifacts_dir(workspace_root, run_id);
    let provider_response_path = artifacts_dir.join("transcription-provider-response.json");
    fs::write(
        &provider_response_path,
        serde_json::to_string_pretty(&json!({ "chunks": chunk_responses }))?,
    )
    .with_context(|| format!("Failed to write '{}'.", provider_response_path.display()))?;
    store::add_artifact(
        &mut run,
        ArtifactKind::ProviderResponse,
        provider_response_path.to_string_lossy().to_string(),
        Some("OpenAI transcription response".to_string()),
    );

    let raw_transcript_path = artifacts_dir.join("transcript-raw.txt");
    fs::write(&raw_transcript_path, &raw_transcript)
        .with_context(|| format!("Failed to write '{}'.", raw_transcript_path.display()))?;
    store::add_artifact(
        &mut run,
        ArtifactKind::RawTranscript,
        raw_transcript_path.to_string_lossy().to_string(),
        Some("Raw transcript".to_string()),
    );
    run.progress_label = Some("Generating cleaned transcript".to_string());
    run.status = MeetingRunStatus::Cleaning;
    save_run(&run)?;

    let cleaned_transcript = cleanup_transcript(
        &client,
        &api_key,
        &settings.cleanup_model,
        &raw_transcript,
        settings.diarization_enabled,
    )?;
    let cleaned_path = artifacts_dir.join("transcript-cleaned.md");
    fs::write(&cleaned_path, &cleaned_transcript)
        .with_context(|| format!("Failed to write '{}'.", cleaned_path.display()))?;
    store::add_artifact(
        &mut run,
        ArtifactKind::CleanedTranscript,
        cleaned_path.to_string_lossy().to_string(),
        Some("Cleaned transcript".to_string()),
    );

    let diarization_note = if settings.diarization_enabled {
        " Speaker labels were requested."
    } else {
        ""
    };
    let review_summary = format!(
        "{} recorded via {}. Raw and cleaned transcripts are ready.{}",
        run.title.clone(),
        run.recording_source.as_label(),
        diarization_note
    );
    set_needs_review(&mut run, review_summary);
    save_run(&run)?;
    Ok(())
}

fn resolve_api_key(settings: &TranscriptionSettings) -> Result<String> {
    settings
        .open_ai_api_key
        .clone()
        .filter(|value| !value.trim().is_empty())
        .or_else(|| std::env::var("OPENAI_API_KEY").ok())
        .filter(|value| !value.trim().is_empty())
        .ok_or_else(|| {
            anyhow!("No OpenAI API key configured. Save one in Settings or set OPENAI_API_KEY.")
        })
}

fn prepare_inputs(
    workspace_root: &Path,
    run_id: &str,
    input_path: &Path,
    settings: &TranscriptionSettings,
) -> Result<Vec<PathBuf>> {
    let input_size = fs::metadata(input_path)?.len();
    if input_size <= OPENAI_FILE_SIZE_LIMIT_BYTES {
        return Ok(vec![input_path.to_path_buf()]);
    }

    ensure_ffmpeg_available(&settings.ffmpeg_path, input_size)?;

    let prepared_dir = run_artifacts_dir(workspace_root, run_id).join("prepared");
    fs::create_dir_all(&prepared_dir)?;

    let compressed_path = prepared_dir.join("transcription-input.mp3");
    let status = Command::new(&settings.ffmpeg_path)
        .args(["-y", "-i"])
        .arg(input_path)
        .args(["-vn", "-ac", "1", "-ar", "16000", "-b:a", "48k"])
        .arg(&compressed_path)
        .status()
        .with_context(|| {
            format!(
                "Failed to launch '{}' for audio preprocessing.",
                settings.ffmpeg_path
            )
        })?;

    if !status.success() {
        return Err(anyhow!(
            "ffmpeg preprocessing failed for '{}'.",
            input_path.display()
        ));
    }

    if fs::metadata(&compressed_path)?.len() <= OPENAI_FILE_SIZE_LIMIT_BYTES {
        return Ok(vec![compressed_path]);
    }

    let chunk_pattern = prepared_dir.join("chunk-%03d.mp3");
    let status = Command::new(&settings.ffmpeg_path)
        .args(["-y", "-i"])
        .arg(&compressed_path)
        .args(["-f", "segment", "-segment_time", "1800", "-c", "copy"])
        .arg(&chunk_pattern)
        .status()
        .with_context(|| format!("Failed to segment '{}'.", compressed_path.display()))?;

    if !status.success() {
        return Err(anyhow!(
            "ffmpeg segmentation failed for '{}'.",
            compressed_path.display()
        ));
    }

    let mut chunks = fs::read_dir(&prepared_dir)?
        .filter_map(|entry| entry.ok())
        .map(|entry| entry.path())
        .filter(|path| {
            path.file_name()
                .and_then(|value| value.to_str())
                .map(|value| value.starts_with("chunk-") && value.ends_with(".mp3"))
                .unwrap_or(false)
        })
        .collect::<Vec<_>>();
    chunks.sort();

    if chunks.is_empty() {
        return Err(anyhow!("No chunk files were created during preprocessing."));
    }

    Ok(chunks)
}

fn ensure_ffmpeg_available(ffmpeg_path: &str, input_size: u64) -> Result<()> {
    match Command::new(ffmpeg_path).arg("-version").output() {
        Ok(output) if output.status.success() => Ok(()),
        Ok(_) => Err(anyhow!(
            "The imported file is {} MB, which exceeds the OpenAI upload limit. FFmpeg is required for compression and chunking. Configure a working FFmpeg path in Settings > Transcription.",
            format_megabytes(input_size)
        )),
        Err(error) if error.kind() == ErrorKind::NotFound => Err(anyhow!(
            "The imported file is {} MB, which exceeds the OpenAI upload limit. FFmpeg is not installed or the configured path '{}' is invalid. Install FFmpeg or set its full path in Settings > Transcription.",
            format_megabytes(input_size),
            ffmpeg_path
        )),
        Err(error) => Err(anyhow!(
            "The imported file is {} MB, which exceeds the OpenAI upload limit. FFmpeg could not be started from '{}': {}",
            format_megabytes(input_size),
            ffmpeg_path,
            error
        )),
    }
}

fn format_megabytes(bytes: u64) -> String {
    format!("{:.1}", bytes as f64 / (1024.0 * 1024.0))
}
fn transcribe_file(
    client: &Client,
    file_path: &Path,
    settings: &TranscriptionSettings,
    api_key: &str,
) -> Result<Value> {
    let model = if settings.diarization_enabled {
        "gpt-4o-transcribe-diarize"
    } else {
        &settings.transcription_model
    };

    let file_part = multipart::Part::file(file_path)
        .with_context(|| format!("Failed to open '{}'.", file_path.display()))?;
    let mut form = multipart::Form::new()
        .part("file", file_part)
        .text("model", model.to_string());

    if settings.diarization_enabled {
        form = form
            .text("response_format", "diarized_json".to_string())
            .text("chunking_strategy", "auto".to_string());
    }

    let response = client
        .post(OPENAI_AUDIO_TRANSCRIPTIONS_URL)
        .bearer_auth(api_key)
        .multipart(form)
        .send()
        .context("OpenAI transcription request failed.")?;

    let status = response.status();
    let body = response
        .text()
        .context("Failed to read OpenAI transcription response.")?;
    if !status.is_success() {
        return Err(anyhow!("OpenAI transcription failed: {}", body));
    }

    let parsed: Value =
        serde_json::from_str(&body).context("Failed to parse OpenAI transcription JSON.")?;
    Ok(parsed)
}

fn extract_transcript_text(payload: &Value, diarization_enabled: bool) -> Option<String> {
    if diarization_enabled {
        let turns = payload.get("segments").and_then(Value::as_array)?;
        let lines = turns
            .iter()
            .filter_map(|segment| {
                let text = segment.get("text").and_then(Value::as_str)?.trim();
                if text.is_empty() {
                    return None;
                }
                let speaker = segment
                    .get("speaker")
                    .and_then(Value::as_str)
                    .or_else(|| segment.get("speaker_id").and_then(Value::as_str))
                    .unwrap_or("Speaker");
                Some(format!("{}: {}", speaker, text))
            })
            .collect::<Vec<_>>();
        if lines.is_empty() {
            return None;
        }
        return Some(lines.join("\n"));
    }

    payload
        .get("text")
        .and_then(Value::as_str)
        .map(ToString::to_string)
        .or_else(|| {
            payload
                .get("segments")
                .and_then(Value::as_array)
                .map(|segments| {
                    segments
                        .iter()
                        .filter_map(|segment| segment.get("text").and_then(Value::as_str))
                        .collect::<Vec<_>>()
                        .join(" ")
                })
        })
}

fn cleanup_transcript(
    client: &Client,
    api_key: &str,
    model: &str,
    transcript: &str,
    diarization_enabled: bool,
) -> Result<String> {
    let prompt = cleanup_prompt(transcript, diarization_enabled);
    let response = client
        .post(OPENAI_RESPONSES_URL)
        .bearer_auth(api_key)
        .json(&json!({
            "model": model,
            "input": prompt,
        }))
        .send()
        .context("OpenAI cleanup request failed.")?;

    let status = response.status();
    let body = response
        .text()
        .context("Failed to read cleanup response.")?;
    if !status.is_success() {
        return Err(anyhow!("OpenAI cleanup failed: {}", body));
    }

    let payload: Value =
        serde_json::from_str(&body).context("Failed to parse cleanup response JSON.")?;
    extract_output_text(&payload)
        .ok_or_else(|| anyhow!("Cleanup response did not include output text."))
}

pub fn stitch_transcripts(chunks: &[String]) -> String {
    chunks
        .iter()
        .map(|chunk| chunk.trim())
        .filter(|chunk| !chunk.is_empty())
        .collect::<Vec<_>>()
        .join("\n\n")
}

pub fn cleanup_prompt(transcript: &str, diarization_enabled: bool) -> String {
    let diarization_instruction = if diarization_enabled {
        "Preserve speaker labels exactly where the transcript already identifies them."
    } else {
        "Do not fabricate speaker labels."
    };

    format!(
        "You are cleaning a meeting transcript for review.\nKeep the original meaning, speaker order, decisions, uncertainties, and action items.\nRemove filler words, duplicate fragments, obvious ASR noise, and broken formatting.\n{}\nDo not invent content. If something is unclear, keep it unclear.\nReturn markdown only.\n\nTranscript:\n{}",
        diarization_instruction,
        transcript.trim()
    )
}

fn extract_output_text(payload: &Value) -> Option<String> {
    if let Some(text) = payload.get("output_text").and_then(Value::as_str) {
        return Some(text.to_string());
    }

    payload
        .get("output")
        .and_then(Value::as_array)
        .and_then(|items| {
            let mut collected = Vec::new();
            for item in items {
                if let Some(contents) = item.get("content").and_then(Value::as_array) {
                    for content in contents {
                        if let Some(text) = content.get("text").and_then(Value::as_str) {
                            collected.push(text.to_string());
                        }
                    }
                }
            }

            if collected.is_empty() {
                None
            } else {
                Some(collected.join("\n"))
            }
        })
}

#[cfg(test)]
mod tests {
    use super::{cleanup_prompt, stitch_transcripts};

    #[test]
    fn stitches_chunk_texts_in_order() {
        let stitched = stitch_transcripts(&[
            "First chunk".to_string(),
            "Second chunk".to_string(),
            "Third chunk".to_string(),
        ]);
        assert_eq!(stitched, "First chunk\n\nSecond chunk\n\nThird chunk");
    }

    #[test]
    fn cleanup_prompt_preserves_verbatim_contract() {
        let prompt = cleanup_prompt("hello world", true);
        assert!(prompt.contains("Keep the original meaning"));
        assert!(prompt.contains("Do not invent content"));
        assert!(prompt.contains("Preserve speaker labels"));
        assert!(prompt.contains("hello world"));
    }
}
