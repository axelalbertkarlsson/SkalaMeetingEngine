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
const DEFAULT_TRANSCRIPTION_DURATION_LIMIT_SECONDS: u64 = 1400;
const DEFAULT_RETRY_CHUNK_DURATION_SECONDS: u64 = 1200;
const CHUNK_DURATION_MARGIN_SECONDS: u64 = 120;
const MIN_RETRY_CHUNK_DURATION_SECONDS: u64 = 300;

type TranscriptionRequestResult<T> = std::result::Result<T, TranscriptionRequestError>;

#[derive(Debug)]
enum TranscriptionRequestError {
    Provider(OpenAiTranscriptionProviderError),
    Other(anyhow::Error),
}

impl From<anyhow::Error> for TranscriptionRequestError {
    fn from(value: anyhow::Error) -> Self {
        Self::Other(value)
    }
}

impl std::fmt::Display for TranscriptionRequestError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::Provider(error) => write!(f, "{}", error),
            Self::Other(error) => write!(f, "{}", error),
        }
    }
}

impl TranscriptionRequestError {
    fn into_anyhow(self) -> anyhow::Error {
        match self {
            Self::Provider(error) => anyhow!("{}", error),
            Self::Other(error) => error,
        }
    }
}

#[derive(Debug, Clone, PartialEq)]
struct OpenAiTranscriptionProviderError {
    message: String,
    error_type: Option<String>,
    code: Option<String>,
    body: String,
}

impl OpenAiTranscriptionProviderError {
    fn parse(body: &str) -> Option<Self> {
        let payload: Value = serde_json::from_str(body).ok()?;
        let error = payload.get("error")?;
        let message = error.get("message").and_then(Value::as_str)?.to_string();
        let error_type = error
            .get("type")
            .and_then(Value::as_str)
            .map(ToString::to_string);
        let code = error
            .get("code")
            .and_then(Value::as_str)
            .map(ToString::to_string);

        Some(Self {
            message,
            error_type,
            code,
            body: body.to_string(),
        })
    }

    fn is_duration_limit(&self) -> bool {
        matches!(self.error_type.as_deref(), Some("invalid_request_error"))
            && matches!(self.code.as_deref(), Some("invalid_value"))
            && parse_duration_limit_seconds(&self.message).is_some()
    }

    fn max_duration_seconds(&self) -> Option<f64> {
        parse_duration_limit_seconds(&self.message)
    }
}

impl std::fmt::Display for OpenAiTranscriptionProviderError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "OpenAI transcription failed: {}", self.body)
    }
}

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

    let prepared_inputs = prepare_inputs_for_size(workspace_root, run_id, &input_path, &settings)?;
    let (chunk_responses, chunk_texts) =
        match transcribe_prepared_inputs(&client, &prepared_inputs, &settings, &api_key) {
            Ok(result) => result,
            Err(TranscriptionRequestError::Provider(error)) if error.is_duration_limit() => {
                run.progress_label = Some("Splitting long audio for upload".to_string());
                save_run(&run)?;

                let retry_inputs = prepare_inputs_for_duration_retry(
                    workspace_root,
                    run_id,
                    &input_path,
                    &settings,
                    error.max_duration_seconds(),
                )?;

                run.progress_label = Some("Retrying upload with shorter audio chunks".to_string());
                save_run(&run)?;

                transcribe_prepared_inputs(&client, &retry_inputs, &settings, &api_key)
                    .map_err(TranscriptionRequestError::into_anyhow)?
            }
            Err(error) => return Err(error.into_anyhow()),
        };

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

fn prepare_inputs_for_size(
    workspace_root: &Path,
    run_id: &str,
    input_path: &Path,
    settings: &TranscriptionSettings,
) -> Result<Vec<PathBuf>> {
    let input_size = fs::metadata(input_path)?.len();
    if input_size <= OPENAI_FILE_SIZE_LIMIT_BYTES {
        return Ok(vec![input_path.to_path_buf()]);
    }

    ensure_ffmpeg_available_for_size(&settings.ffmpeg_path, input_size)?;

    let prepared_dir = run_artifacts_dir(workspace_root, run_id).join("prepared");
    fs::create_dir_all(&prepared_dir)?;

    let compressed_path = prepared_dir.join("transcription-input.mp3");
    transcode_audio(
        &settings.ffmpeg_path,
        input_path,
        &compressed_path,
        "audio preprocessing",
    )?;

    if fs::metadata(&compressed_path)?.len() <= OPENAI_FILE_SIZE_LIMIT_BYTES {
        return Ok(vec![compressed_path]);
    }

    let chunk_pattern = prepared_dir.join("chunk-%03d.mp3");
    segment_audio(
        &settings.ffmpeg_path,
        &compressed_path,
        &chunk_pattern,
        DEFAULT_RETRY_CHUNK_DURATION_SECONDS,
        "oversized audio preprocessing",
    )?;

    collect_chunk_paths(&prepared_dir, "chunk-")
}

fn prepare_inputs_for_duration_retry(
    workspace_root: &Path,
    run_id: &str,
    input_path: &Path,
    settings: &TranscriptionSettings,
    max_duration_seconds: Option<f64>,
) -> Result<Vec<PathBuf>> {
    ensure_ffmpeg_available_for_duration_retry(&settings.ffmpeg_path, max_duration_seconds)?;

    let prepared_dir = run_artifacts_dir(workspace_root, run_id).join("prepared");
    fs::create_dir_all(&prepared_dir)?;

    let compressed_path = prepared_dir.join("duration-retry-input.mp3");
    transcode_audio(
        &settings.ffmpeg_path,
        input_path,
        &compressed_path,
        "duration-aware audio preprocessing",
    )?;

    let chunk_pattern = prepared_dir.join("duration-chunk-%03d.mp3");
    segment_audio(
        &settings.ffmpeg_path,
        &compressed_path,
        &chunk_pattern,
        recommended_chunk_duration_seconds(max_duration_seconds),
        "duration-aware audio chunking",
    )?;

    collect_chunk_paths(&prepared_dir, "duration-chunk-")
}

fn ensure_ffmpeg_available_for_size(ffmpeg_path: &str, input_size: u64) -> Result<()> {
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

fn ensure_ffmpeg_available_for_duration_retry(
    ffmpeg_path: &str,
    max_duration_seconds: Option<f64>,
) -> Result<()> {
    let duration_limit_seconds = normalize_duration_seconds(max_duration_seconds)
        .unwrap_or(DEFAULT_TRANSCRIPTION_DURATION_LIMIT_SECONDS);
    match Command::new(ffmpeg_path).arg("-version").output() {
        Ok(output) if output.status.success() => Ok(()),
        Ok(_) => Err(anyhow!(
            "The uploaded audio is longer than the model's {} second limit. FFmpeg is required so the app can split the recording into shorter chunks. Configure a working FFmpeg path in Settings > Transcription.",
            duration_limit_seconds
        )),
        Err(error) if error.kind() == ErrorKind::NotFound => Err(anyhow!(
            "The uploaded audio is longer than the model's {} second limit. FFmpeg is not installed or the configured path '{}' is invalid. Install FFmpeg or set its full path in Settings > Transcription.",
            duration_limit_seconds,
            ffmpeg_path
        )),
        Err(error) => Err(anyhow!(
            "The uploaded audio is longer than the model's {} second limit. FFmpeg could not be started from '{}': {}",
            duration_limit_seconds,
            ffmpeg_path,
            error
        )),
    }
}

fn transcode_audio(
    ffmpeg_path: &str,
    input_path: &Path,
    output_path: &Path,
    action: &str,
) -> Result<()> {
    let status = Command::new(ffmpeg_path)
        .args(["-y", "-i"])
        .arg(input_path)
        .args(["-vn", "-ac", "1", "-ar", "16000", "-b:a", "48k"])
        .arg(output_path)
        .status()
        .with_context(|| format!("Failed to launch '{}' for {}.", ffmpeg_path, action))?;

    if !status.success() {
        return Err(anyhow!(
            "ffmpeg {} failed for '{}'.",
            action,
            input_path.display()
        ));
    }

    Ok(())
}

fn segment_audio(
    ffmpeg_path: &str,
    input_path: &Path,
    chunk_pattern: &Path,
    segment_time_seconds: u64,
    action: &str,
) -> Result<()> {
    let status = Command::new(ffmpeg_path)
        .args(["-y", "-i"])
        .arg(input_path)
        .args([
            "-f",
            "segment",
            "-segment_time",
            &segment_time_seconds.to_string(),
            "-c",
            "copy",
        ])
        .arg(chunk_pattern)
        .status()
        .with_context(|| format!("Failed to launch '{}' for {}.", ffmpeg_path, action))?;

    if !status.success() {
        return Err(anyhow!(
            "ffmpeg {} failed for '{}'.",
            action,
            input_path.display()
        ));
    }

    Ok(())
}

fn collect_chunk_paths(prepared_dir: &Path, prefix: &str) -> Result<Vec<PathBuf>> {
    let mut chunks = fs::read_dir(prepared_dir)?
        .filter_map(|entry| entry.ok())
        .map(|entry| entry.path())
        .filter(|path| {
            path.file_name()
                .and_then(|value| value.to_str())
                .map(|value| value.starts_with(prefix) && value.ends_with(".mp3"))
                .unwrap_or(false)
        })
        .collect::<Vec<_>>();
    chunks.sort();

    if chunks.is_empty() {
        return Err(anyhow!("No chunk files were created during preprocessing."));
    }

    Ok(chunks)
}

fn normalize_duration_seconds(seconds: Option<f64>) -> Option<u64> {
    seconds
        .filter(|value| value.is_finite() && *value > 0.0)
        .map(|value| value.floor() as u64)
}

fn recommended_chunk_duration_seconds(max_duration_seconds: Option<f64>) -> u64 {
    let provider_safe_limit = normalize_duration_seconds(max_duration_seconds)
        .map(|seconds| seconds.saturating_sub(CHUNK_DURATION_MARGIN_SECONDS))
        .map(|seconds| seconds.max(MIN_RETRY_CHUNK_DURATION_SECONDS));

    provider_safe_limit
        .unwrap_or(DEFAULT_RETRY_CHUNK_DURATION_SECONDS)
        .min(DEFAULT_RETRY_CHUNK_DURATION_SECONDS)
        .max(MIN_RETRY_CHUNK_DURATION_SECONDS)
}

fn parse_duration_limit_seconds(message: &str) -> Option<f64> {
    let lowercase = message.to_ascii_lowercase();
    if !lowercase.contains("audio duration")
        || !lowercase.contains("is longer than")
        || !lowercase.contains("maximum for this model")
    {
        return None;
    }

    let after_limit_marker = lowercase.split_once("is longer than")?.1.trim_start();
    let raw_value = after_limit_marker.split_whitespace().next()?;
    raw_value
        .trim_matches(|char: char| !(char.is_ascii_digit() || char == '.'))
        .parse::<f64>()
        .ok()
}

fn format_megabytes(bytes: u64) -> String {
    format!("{:.1}", bytes as f64 / (1024.0 * 1024.0))
}

fn transcribe_prepared_inputs(
    client: &Client,
    prepared_inputs: &[PathBuf],
    settings: &TranscriptionSettings,
    api_key: &str,
) -> TranscriptionRequestResult<(Vec<Value>, Vec<String>)> {
    let mut chunk_responses = Vec::new();
    let mut chunk_texts = Vec::new();

    for prepared in prepared_inputs {
        let response = transcribe_file(client, prepared, settings, api_key)?;
        let transcript_text = extract_transcript_text(&response, settings.diarization_enabled)
            .ok_or_else(|| {
                anyhow!("OpenAI transcription response did not contain transcript text.")
            })
            .map_err(TranscriptionRequestError::from)?;

        chunk_texts.push(transcript_text);
        chunk_responses.push(response);
    }

    Ok((chunk_responses, chunk_texts))
}

fn transcribe_file(
    client: &Client,
    file_path: &Path,
    settings: &TranscriptionSettings,
    api_key: &str,
) -> TranscriptionRequestResult<Value> {
    let model = if settings.diarization_enabled {
        "gpt-4o-transcribe-diarize"
    } else {
        &settings.transcription_model
    };

    let file_part = multipart::Part::file(file_path)
        .with_context(|| format!("Failed to open '{}'.", file_path.display()))
        .map_err(TranscriptionRequestError::from)?;
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
        .context("OpenAI transcription request failed.")
        .map_err(TranscriptionRequestError::from)?;

    let status = response.status();
    let body = response
        .text()
        .context("Failed to read OpenAI transcription response.")
        .map_err(TranscriptionRequestError::from)?;
    if !status.is_success() {
        if let Some(error) = OpenAiTranscriptionProviderError::parse(&body) {
            return Err(TranscriptionRequestError::Provider(error));
        }

        return Err(TranscriptionRequestError::Other(anyhow!(
            "OpenAI transcription failed: {}",
            body
        )));
    }

    let parsed: Value = serde_json::from_str(&body)
        .context("Failed to parse OpenAI transcription JSON.")
        .map_err(TranscriptionRequestError::from)?;
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
    use super::{
        cleanup_prompt, parse_duration_limit_seconds, recommended_chunk_duration_seconds,
        stitch_transcripts, OpenAiTranscriptionProviderError,
    };

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

    #[test]
    fn parses_duration_limit_seconds_from_openai_error_message() {
        let seconds = parse_duration_limit_seconds(
            "audio duration 2784.96 seconds is longer than 1400 seconds which is the maximum for this model",
        );
        assert_eq!(seconds, Some(1400.0));
    }

    #[test]
    fn ignores_non_duration_error_messages() {
        let seconds = parse_duration_limit_seconds("unsupported audio format");
        assert_eq!(seconds, None);
    }

    #[test]
    fn recognizes_duration_limit_provider_errors() {
        let error = OpenAiTranscriptionProviderError::parse(
            r#"{"error":{"message":"audio duration 2784.96 seconds is longer than 1400 seconds which is the maximum for this model","type":"invalid_request_error","code":"invalid_value"}}"#,
        )
        .expect("provider error should parse");

        assert!(error.is_duration_limit());
        assert_eq!(error.max_duration_seconds(), Some(1400.0));
    }

    #[test]
    fn keeps_retry_chunk_duration_safely_below_provider_limit() {
        assert_eq!(recommended_chunk_duration_seconds(Some(1400.0)), 1200);
        assert_eq!(recommended_chunk_duration_seconds(Some(900.0)), 780);
        assert_eq!(recommended_chunk_duration_seconds(None), 1200);
    }
}
