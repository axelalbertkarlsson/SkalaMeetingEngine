use std::{
    fs::{File, OpenOptions},
    io::{BufWriter, Write},
    path::{Path, PathBuf},
    process::{Child, Command, Stdio},
};

use anyhow::{anyhow, Context, Result};

#[cfg(target_os = "windows")]
use std::{
    sync::{
        atomic::{AtomicBool, Ordering},
        mpsc, Arc, Mutex,
    },
    thread::{self, JoinHandle},
    time::Duration,
};

#[cfg(target_os = "windows")]
use cpal::{
    traits::{DeviceTrait, HostTrait, StreamTrait},
    SampleFormat, StreamConfig,
};
#[cfg(target_os = "windows")]
use hound::{SampleFormat as WavSampleFormat, WavSpec, WavWriter};

use super::{
    models::RecordingSource,
    store::{run_artifacts_dir, run_input_dir},
};

pub struct RecordingSession {
    pub run_id: String,
    pub workspace_root: String,
    pub output_path: String,
    pub log_path: String,
    backend: RecordingBackend,
}

enum RecordingBackend {
    Ffmpeg(Child),
    #[cfg(target_os = "windows")]
    NativeSystemAudio(NativeRecordingSession),
    #[cfg(target_os = "windows")]
    Mixed(MixedRecordingSession),
}

#[cfg(target_os = "windows")]
struct NativeRecordingSession {
    stop_flag: Arc<AtomicBool>,
    join_handle: Option<JoinHandle<Result<()>>>,
}

#[cfg(target_os = "windows")]
struct MixedRecordingSession {
    system_audio: NativeRecordingSession,
    microphone: Child,
    ffmpeg_path: String,
    microphone_output_path: PathBuf,
    system_output_path: PathBuf,
}

pub fn spawn_recording(
    ffmpeg_path: &str,
    workspace_root: &Path,
    run_id: &str,
    source: &RecordingSource,
) -> Result<(RecordingSession, PathBuf, PathBuf)> {
    if !cfg!(target_os = "windows") {
        return Err(anyhow!(
            "Live recording is only implemented on Windows in v1."
        ));
    }

    let input_dir = run_input_dir(workspace_root, run_id);
    let artifacts_dir = run_artifacts_dir(workspace_root, run_id);
    std::fs::create_dir_all(&input_dir)?;
    std::fs::create_dir_all(&artifacts_dir)?;

    let output_path = input_dir.join("recording.wav");
    let log_path = artifacts_dir.join("recording.log");
    initialize_log(&log_path)?;

    let backend = match source {
        RecordingSource::Microphone => RecordingBackend::Ffmpeg(spawn_ffmpeg_process(
            build_ffmpeg_microphone_command(ffmpeg_path, &output_path)?,
            &log_path,
            ffmpeg_path,
        )?),
        RecordingSource::SystemAudio => {
            #[cfg(target_os = "windows")]
            {
                RecordingBackend::NativeSystemAudio(spawn_native_system_audio_recording(
                    &output_path,
                    &log_path,
                )?)
            }
            #[cfg(not(target_os = "windows"))]
            unreachable!()
        }
        RecordingSource::Mixed => {
            #[cfg(target_os = "windows")]
            {
                let microphone_output_path = input_dir.join("recording_microphone.wav");
                let system_output_path = input_dir.join("recording_system.wav");

                let system_audio =
                    spawn_native_system_audio_recording(&system_output_path, &log_path)?;
                let microphone_command =
                    build_ffmpeg_microphone_command(ffmpeg_path, &microphone_output_path)?;
                let microphone =
                    match spawn_ffmpeg_process(microphone_command, &log_path, ffmpeg_path) {
                        Ok(child) => child,
                        Err(error) => {
                            let mut system_audio = system_audio;
                            let _ = stop_native_recording(&mut system_audio);
                            return Err(error);
                        }
                    };

                RecordingBackend::Mixed(MixedRecordingSession {
                    system_audio,
                    microphone,
                    ffmpeg_path: ffmpeg_path.to_string(),
                    microphone_output_path,
                    system_output_path,
                })
            }
            #[cfg(not(target_os = "windows"))]
            unreachable!()
        }
        RecordingSource::ImportedFile => {
            return Err(anyhow!(
                "Imported files do not use the live recording backend."
            ));
        }
    };

    Ok((
        RecordingSession {
            run_id: run_id.to_string(),
            workspace_root: workspace_root.to_string_lossy().to_string(),
            output_path: output_path.to_string_lossy().to_string(),
            log_path: log_path.to_string_lossy().to_string(),
            backend,
        },
        output_path,
        log_path,
    ))
}

pub fn stop_recording(session: &mut RecordingSession) -> Result<()> {
    match &mut session.backend {
        RecordingBackend::Ffmpeg(child) => stop_ffmpeg_recording(child, &session.log_path),
        #[cfg(target_os = "windows")]
        RecordingBackend::NativeSystemAudio(native) => stop_native_recording(native),
        #[cfg(target_os = "windows")]
        RecordingBackend::Mixed(mixed) => {
            stop_ffmpeg_recording(&mut mixed.microphone, &session.log_path)?;
            stop_native_recording(&mut mixed.system_audio)?;
            mix_recordings(
                &mixed.ffmpeg_path,
                &mixed.microphone_output_path,
                &mixed.system_output_path,
                Path::new(&session.output_path),
                Path::new(&session.log_path),
            )?;

            let _ = std::fs::remove_file(&mixed.microphone_output_path);
            let _ = std::fs::remove_file(&mixed.system_output_path);
            Ok(())
        }
    }
}

fn initialize_log(log_path: &Path) -> Result<()> {
    File::create(log_path).with_context(|| format!("Failed to create '{}'.", log_path.display()))?;
    Ok(())
}

fn build_ffmpeg_microphone_command(ffmpeg_path: &str, output_path: &Path) -> Result<Command> {
    let microphone = detect_microphone_device(ffmpeg_path)?;
    let mut command = Command::new(ffmpeg_path);
    command
        .arg("-y")
        .args(["-f", "dshow", "-i"])
        .arg(format!("audio={microphone}"))
        .args(["-acodec", "pcm_s16le", "-ar", "44100", "-ac", "2"])
        .arg(output_path);
    Ok(command)
}

fn spawn_ffmpeg_process(
    mut command: Command,
    log_path: &Path,
    ffmpeg_path: &str,
) -> Result<Child> {
    let log_file = open_log_append(log_path)?;
    let log_file_err = log_file.try_clone()?;

    command.stdin(Stdio::piped());
    command.stdout(Stdio::from(log_file));
    command.stderr(Stdio::from(log_file_err));

    command
        .spawn()
        .with_context(|| format!("Failed to start ffmpeg using '{}'.", ffmpeg_path))
}

fn stop_ffmpeg_recording(child: &mut Child, log_path: &str) -> Result<()> {
    if let Some(stdin) = &mut child.stdin {
        let _ = stdin.write_all(b"q\n");
        let _ = stdin.flush();
    }

    let status = child.wait().context("Failed to wait for ffmpeg to stop.")?;
    if !status.success() {
        return Err(anyhow!(
            "ffmpeg exited with status {:?}. See '{}' for details.",
            status.code(),
            log_path
        ));
    }

    Ok(())
}

fn detect_microphone_device(ffmpeg_path: &str) -> Result<String> {
    let devices = list_audio_devices(ffmpeg_path)?;
    devices
        .iter()
        .find(|name| !looks_like_system_audio(name))
        .cloned()
        .ok_or_else(|| anyhow!("No microphone-like audio input device was found via ffmpeg dshow."))
}

fn looks_like_system_audio(name: &str) -> bool {
    let normalized = name.to_ascii_lowercase();
    normalized.contains("stereo mix")
        || normalized.contains("stereomix")
        || normalized.contains("what u hear")
        || normalized.contains("wave out")
        || normalized.contains("loopback")
        || normalized.contains("cable output")
        || normalized.contains("vb-audio")
        || normalized.contains("voicemeeter")
        || normalized.contains("wave link system")
        || normalized.contains("virtual-audio-capturer")
}

fn list_audio_devices(ffmpeg_path: &str) -> Result<Vec<String>> {
    let output = Command::new(ffmpeg_path)
        .args([
            "-hide_banner",
            "-list_devices",
            "true",
            "-f",
            "dshow",
            "-i",
            "dummy",
        ])
        .output()
        .with_context(|| format!("Failed to list devices with '{}'.", ffmpeg_path))?;

    let stderr = String::from_utf8_lossy(&output.stderr);
    let stdout = String::from_utf8_lossy(&output.stdout);
    let combined = if stdout.is_empty() {
        stderr.into_owned()
    } else {
        format!("{stderr}\n{stdout}")
    };
    let devices = parse_audio_devices(&combined);

    if devices.is_empty() {
        return Err(anyhow!(
            "ffmpeg did not report any audio capture devices. Verify '{} -list_devices true -f dshow -i dummy'.",
            ffmpeg_path
        ));
    }

    Ok(devices)
}

fn parse_audio_devices(output: &str) -> Vec<String> {
    let has_explicit_audio_section = output.contains("DirectShow audio devices");
    let mut in_audio_section = !has_explicit_audio_section;
    let mut devices = Vec::new();

    for line in output.lines() {
        let trimmed = line.trim();

        if trimmed.contains("DirectShow audio devices") {
            in_audio_section = true;
            continue;
        }

        if trimmed.contains("DirectShow video devices") {
            in_audio_section = false;
            continue;
        }

        if !in_audio_section || trimmed.contains("Alternative name") {
            continue;
        }

        let is_audio_device_line = if has_explicit_audio_section {
            !trimmed.is_empty() && !trimmed.contains("DirectShow")
        } else {
            trimmed.contains("(audio)")
        };

        if !is_audio_device_line {
            continue;
        }

        if let Some(device_name) = extract_quoted_value(trimmed) {
            if !devices.contains(&device_name) {
                devices.push(device_name);
            }
        }
    }

    devices
}

fn extract_quoted_value(line: &str) -> Option<String> {
    let start = line.find('"')?;
    let end = line.rfind('"')?;
    if end <= start {
        return None;
    }

    Some(line[start + 1..end].to_string())
}

fn open_log_append(log_path: &Path) -> Result<File> {
    OpenOptions::new()
        .create(true)
        .append(true)
        .open(log_path)
        .with_context(|| format!("Failed to open '{}' for append.", log_path.display()))
}

fn append_log_line(log_path: &Path, message: &str) -> Result<()> {
    let mut file = open_log_append(log_path)?;
    writeln!(file, "{message}")?;
    Ok(())
}

fn run_ffmpeg_command(mut command: Command, log_path: &Path, ffmpeg_path: &str) -> Result<()> {
    let log_file = open_log_append(log_path)?;
    let log_file_err = log_file.try_clone()?;
    command.stdout(Stdio::from(log_file));
    command.stderr(Stdio::from(log_file_err));

    let status = command
        .status()
        .with_context(|| format!("Failed to run ffmpeg using '{}'.", ffmpeg_path))?;
    if !status.success() {
        return Err(anyhow!(
            "ffmpeg exited with status {:?}. See '{}' for details.",
            status.code(),
            log_path.display()
        ));
    }

    Ok(())
}

fn mix_recordings(
    ffmpeg_path: &str,
    microphone_path: &Path,
    system_path: &Path,
    output_path: &Path,
    log_path: &Path,
) -> Result<()> {
    append_log_line(log_path, "Mixing microphone and system audio into final recording.")?;

    let mut command = Command::new(ffmpeg_path);
    command
        .arg("-y")
        .arg("-i")
        .arg(microphone_path)
        .arg("-i")
        .arg(system_path)
        .args([
            "-filter_complex",
            "[0:a][1:a]amix=inputs=2:weights='1 1':normalize=0:duration=longest",
        ])
        .args(["-acodec", "pcm_s16le", "-ar", "44100", "-ac", "2"])
        .arg(output_path);

    run_ffmpeg_command(command, log_path, ffmpeg_path)
}

#[cfg(target_os = "windows")]
fn spawn_native_system_audio_recording(
    output_path: &Path,
    log_path: &Path,
) -> Result<NativeRecordingSession> {
    let stop_flag = Arc::new(AtomicBool::new(false));
    let thread_stop_flag = Arc::clone(&stop_flag);
    let output_path = output_path.to_path_buf();
    let log_path = log_path.to_path_buf();
    let (ready_tx, ready_rx) = mpsc::sync_channel(1);

    let join_handle = thread::spawn(move || {
        run_native_system_audio_recording(output_path, log_path, thread_stop_flag, ready_tx)
    });

    match ready_rx.recv_timeout(Duration::from_secs(5)) {
        Ok(Ok(())) => Ok(NativeRecordingSession {
            stop_flag,
            join_handle: Some(join_handle),
        }),
        Ok(Err(message)) => {
            let _ = join_handle.join();
            Err(anyhow!(message))
        }
        Err(_) => {
            stop_flag.store(true, Ordering::SeqCst);
            let _ = join_handle.join();
            Err(anyhow!(
                "Timed out while starting Windows system audio capture."
            ))
        }
    }
}

#[cfg(target_os = "windows")]
fn stop_native_recording(session: &mut NativeRecordingSession) -> Result<()> {
    session.stop_flag.store(true, Ordering::SeqCst);
    let join_handle = session
        .join_handle
        .take()
        .ok_or_else(|| anyhow!("System audio capture thread was already stopped."))?;
    join_handle
        .join()
        .map_err(|_| anyhow!("System audio capture thread panicked."))?
}

#[cfg(target_os = "windows")]
fn run_native_system_audio_recording(
    output_path: PathBuf,
    log_path: PathBuf,
    stop_flag: Arc<AtomicBool>,
    ready_tx: mpsc::SyncSender<std::result::Result<(), String>>,
) -> Result<()> {
    let result = native_system_audio_recording_loop(
        output_path.as_path(),
        log_path.as_path(),
        stop_flag,
        &ready_tx,
    );

    if let Err(error) = &result {
        let _ = append_log_line(
            log_path.as_path(),
            &format!("Windows system audio capture failed: {error}"),
        );
    }

    result
}

#[cfg(target_os = "windows")]
fn native_system_audio_recording_loop(
    output_path: &Path,
    log_path: &Path,
    stop_flag: Arc<AtomicBool>,
    ready_tx: &mpsc::SyncSender<std::result::Result<(), String>>,
) -> Result<()> {
    append_log_line(log_path, "Starting Windows system audio capture via WASAPI loopback.")?;

    let host = cpal::default_host();
    let device = host
        .default_output_device()
        .ok_or_else(|| anyhow!("No default Windows output device was found for system audio capture."))?;
    let device_name = device
        .name()
        .unwrap_or_else(|_| "Unknown Windows output device".to_string());
    let supported_config = device
        .default_output_config()
        .with_context(|| format!("Failed to read the default output config for '{device_name}'."))?;
    let sample_format = supported_config.sample_format();
    let config: StreamConfig = supported_config.clone().into();

    if !matches!(
        sample_format,
        SampleFormat::F32 | SampleFormat::I16 | SampleFormat::U16
    ) {
        let message = format!(
            "Unsupported Windows output sample format '{sample_format:?}' for WASAPI loopback."
        );
        let _ = ready_tx.send(Err(message.clone()));
        return Err(anyhow!(message));
    }

    append_log_line(
        log_path,
        &format!(
            "Capturing system audio from '{device_name}' at {} Hz with {} channel(s) using {:?}.",
            config.sample_rate.0, config.channels, sample_format
        ),
    )?;

    let writer = Arc::new(Mutex::new(Some(WavWriterHandle::create(
        output_path,
        &config,
        sample_format,
    )?)));
    let callback_error = Arc::new(Mutex::new(None::<String>));

    let stream = build_loopback_stream(
        &device,
        &config,
        sample_format,
        Arc::clone(&writer),
        Arc::clone(&callback_error),
        log_path.to_path_buf(),
    )?;
    stream
        .play()
        .context("Failed to start the WASAPI loopback stream.")?;

    let _ = ready_tx.send(Ok(()));

    while !stop_flag.load(Ordering::SeqCst) {
        if callback_error
            .lock()
            .map_err(|_| anyhow!("System audio capture error state was poisoned."))?
            .is_some()
        {
            break;
        }

        thread::sleep(Duration::from_millis(50));
    }

    drop(stream);

    let finalize_result = finalize_wav_writer(&writer);
    if let Err(error) = finalize_result {
        store_callback_error(
            &callback_error,
            log_path,
            format!("Failed to finalize the system audio recording: {error}"),
        );
    }

    if let Some(message) = callback_error
        .lock()
        .map_err(|_| anyhow!("System audio capture error state was poisoned."))?
        .take()
    {
        return Err(anyhow!(message));
    }

    append_log_line(log_path, "Windows system audio capture stopped cleanly.")?;
    Ok(())
}

#[cfg(target_os = "windows")]
fn build_loopback_stream(
    device: &cpal::Device,
    config: &StreamConfig,
    sample_format: SampleFormat,
    writer: Arc<Mutex<Option<WavWriterHandle>>>,
    callback_error: Arc<Mutex<Option<String>>>,
    log_path: PathBuf,
) -> Result<cpal::Stream> {
    let error_callback_state = Arc::clone(&callback_error);
    let error_callback_log_path = log_path.clone();
    let error_callback = move |error| {
        store_callback_error(
            &error_callback_state,
            &error_callback_log_path,
            format!("WASAPI loopback stream error: {error}"),
        );
    };

    match sample_format {
        SampleFormat::F32 => device
            .build_input_stream(
                config,
                {
                    let callback_error = Arc::clone(&callback_error);
                    let log_path = log_path.clone();
                    move |data: &[f32], _| {
                        if let Err(error) = write_wav_samples(&writer, data) {
                            store_callback_error(
                                &callback_error,
                                &log_path,
                                format!("Failed to write f32 loopback samples: {error}"),
                            );
                        }
                    }
                },
                error_callback,
                None,
            )
            .context("Failed to build the f32 WASAPI loopback stream."),
        SampleFormat::I16 => device
            .build_input_stream(
                config,
                {
                    let callback_error = Arc::clone(&callback_error);
                    let log_path = log_path.clone();
                    move |data: &[i16], _| {
                        if let Err(error) = write_wav_samples(&writer, data) {
                            store_callback_error(
                                &callback_error,
                                &log_path,
                                format!("Failed to write i16 loopback samples: {error}"),
                            );
                        }
                    }
                },
                error_callback,
                None,
            )
            .context("Failed to build the i16 WASAPI loopback stream."),
        SampleFormat::U16 => device
            .build_input_stream(
                config,
                {
                    let callback_error = Arc::clone(&callback_error);
                    let log_path = log_path.clone();
                    move |data: &[u16], _| {
                        if let Err(error) = write_wav_samples(&writer, data) {
                            store_callback_error(
                                &callback_error,
                                &log_path,
                                format!("Failed to write u16 loopback samples: {error}"),
                            );
                        }
                    }
                },
                error_callback,
                None,
            )
            .context("Failed to build the u16 WASAPI loopback stream."),
        _ => Err(anyhow!(
            "Unsupported Windows output sample format '{sample_format:?}' for WASAPI loopback."
        )),
    }
}

#[cfg(target_os = "windows")]
fn store_callback_error(
    callback_error: &Arc<Mutex<Option<String>>>,
    log_path: &Path,
    message: String,
) {
    let mut guard = match callback_error.lock() {
        Ok(guard) => guard,
        Err(_) => return,
    };

    if guard.is_none() {
        let _ = append_log_line(log_path, &message);
        *guard = Some(message);
    }
}

#[cfg(target_os = "windows")]
fn finalize_wav_writer(writer: &Arc<Mutex<Option<WavWriterHandle>>>) -> Result<()> {
    let mut guard = writer
        .lock()
        .map_err(|_| anyhow!("System audio writer lock was poisoned."))?;
    if let Some(writer) = guard.take() {
        writer.finalize()?;
    }
    Ok(())
}

#[cfg(target_os = "windows")]
fn write_wav_samples<T>(
    writer: &Arc<Mutex<Option<WavWriterHandle>>>,
    data: &[T],
) -> Result<()>
where
    T: Copy,
    WavWriterHandle: WavWritable<T>,
{
    let mut guard = writer
        .lock()
        .map_err(|_| anyhow!("System audio writer lock was poisoned."))?;
    let wav_writer = guard
        .as_mut()
        .ok_or_else(|| anyhow!("System audio writer was finalized before capture stopped."))?;
    wav_writer.write_samples(data)
}

#[cfg(target_os = "windows")]
trait WavWritable<T> {
    fn write_samples(&mut self, data: &[T]) -> Result<()>;
}

#[cfg(target_os = "windows")]
enum WavWriterHandle {
    F32(WavWriter<BufWriter<File>>),
    I16(WavWriter<BufWriter<File>>),
}

#[cfg(target_os = "windows")]
impl WavWriterHandle {
    fn create(output_path: &Path, config: &StreamConfig, sample_format: SampleFormat) -> Result<Self> {
        let wav_spec = WavSpec {
            channels: config.channels,
            sample_rate: config.sample_rate.0,
            bits_per_sample: match sample_format {
                SampleFormat::F32 => 32,
                SampleFormat::I16 | SampleFormat::U16 => 16,
                _ => {
                    return Err(anyhow!(
                        "Unsupported Windows output sample format '{sample_format:?}' for WAV writing."
                    ))
                }
            },
            sample_format: match sample_format {
                SampleFormat::F32 => WavSampleFormat::Float,
                SampleFormat::I16 | SampleFormat::U16 => WavSampleFormat::Int,
                _ => unreachable!(),
            },
        };

        let writer = WavWriter::create(output_path, wav_spec)
            .with_context(|| format!("Failed to create '{}'.", output_path.display()))?;

        Ok(match sample_format {
            SampleFormat::F32 => Self::F32(writer),
            SampleFormat::I16 | SampleFormat::U16 => Self::I16(writer),
            _ => unreachable!(),
        })
    }

    fn finalize(self) -> Result<()> {
        match self {
            Self::F32(writer) => writer.finalize().context("Failed to finalize f32 WAV output."),
            Self::I16(writer) => writer.finalize().context("Failed to finalize i16 WAV output."),
        }
    }
}

#[cfg(target_os = "windows")]
impl WavWritable<f32> for WavWriterHandle {
    fn write_samples(&mut self, data: &[f32]) -> Result<()> {
        match self {
            Self::F32(writer) => {
                for sample in data {
                    writer.write_sample(*sample)?;
                }
                Ok(())
            }
            _ => Err(anyhow!("Attempted to write f32 samples into a non-f32 WAV writer.")),
        }
    }
}

#[cfg(target_os = "windows")]
impl WavWritable<i16> for WavWriterHandle {
    fn write_samples(&mut self, data: &[i16]) -> Result<()> {
        match self {
            Self::I16(writer) => {
                for sample in data {
                    writer.write_sample(*sample)?;
                }
                Ok(())
            }
            _ => Err(anyhow!("Attempted to write i16 samples into a non-i16 WAV writer.")),
        }
    }
}

#[cfg(target_os = "windows")]
impl WavWritable<u16> for WavWriterHandle {
    fn write_samples(&mut self, data: &[u16]) -> Result<()> {
        match self {
            Self::I16(writer) => {
                for sample in data {
                    writer.write_sample((*sample as i32 - 32_768) as i16)?;
                }
                Ok(())
            }
            _ => Err(anyhow!("Attempted to write u16 samples into a non-i16 WAV writer.")),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::parse_audio_devices;

    #[test]
    fn parses_headerless_audio_device_output() {
        let output = r#"
[in#0 @ 000001ce92de7f40] "Integrated Camera" (video)
[in#0 @ 000001ce92de7f40]   Alternative name "@device_pnp_camera"
[in#0 @ 000001ce92de7f40] "Microphone Array (AMD Audio Device)" (audio)
[in#0 @ 000001ce92de7f40]   Alternative name "@device_cm_microphone"
Error opening input file dummy.
"#;

        let devices = parse_audio_devices(output);

        assert_eq!(devices, vec!["Microphone Array (AMD Audio Device)"]);
    }

    #[test]
    fn parses_audio_device_output_with_explicit_sections() {
        let output = r#"
[dshow @ 000001] DirectShow video devices
[dshow @ 000001]  "Integrated Camera"
[dshow @ 000001]     Alternative name "@device_pnp_camera"
[dshow @ 000001] DirectShow audio devices
[dshow @ 000001]  "Microphone Array (AMD Audio Device)"
[dshow @ 000001]     Alternative name "@device_cm_microphone"
[dshow @ 000001]  "Stereo Mix (Realtek(R) Audio)"
[dshow @ 000001]     Alternative name "@device_cm_stereomix"
"#;

        let devices = parse_audio_devices(output);

        assert_eq!(
            devices,
            vec![
                "Microphone Array (AMD Audio Device)",
                "Stereo Mix (Realtek(R) Audio)"
            ]
        );
    }
}
