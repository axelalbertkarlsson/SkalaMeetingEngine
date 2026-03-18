use std::{
    fs::File,
    io::Write,
    path::{Path, PathBuf},
    process::{Child, Command, Stdio},
};

use anyhow::{anyhow, Context, Result};

use super::{
    models::RecordingSource,
    store::{run_artifacts_dir, run_input_dir},
};

pub struct RecordingSession {
    pub run_id: String,
    pub workspace_root: String,
    pub output_path: String,
    pub log_path: String,
    pub child: Child,
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
    let mut command = build_ffmpeg_command(ffmpeg_path, source, &output_path)?;

    let log_file = File::create(&log_path)
        .with_context(|| format!("Failed to create '{}'.", log_path.display()))?;
    let log_file_err = log_file.try_clone()?;

    command.stdin(Stdio::piped());
    command.stdout(Stdio::from(log_file));
    command.stderr(Stdio::from(log_file_err));

    let child = command
        .spawn()
        .with_context(|| format!("Failed to start ffmpeg using '{}'.", ffmpeg_path))?;

    Ok((
        RecordingSession {
            run_id: run_id.to_string(),
            workspace_root: workspace_root.to_string_lossy().to_string(),
            output_path: output_path.to_string_lossy().to_string(),
            log_path: log_path.to_string_lossy().to_string(),
            child,
        },
        output_path,
        log_path,
    ))
}

pub fn stop_recording(session: &mut RecordingSession) -> Result<()> {
    if let Some(stdin) = &mut session.child.stdin {
        let _ = stdin.write_all(b"q\n");
        let _ = stdin.flush();
    }

    let status = session
        .child
        .wait()
        .context("Failed to wait for ffmpeg to stop.")?;
    if !status.success() {
        return Err(anyhow!(
            "ffmpeg exited with status {:?}. See '{}' for details.",
            status.code(),
            session.log_path
        ));
    }

    Ok(())
}

fn build_ffmpeg_command(
    ffmpeg_path: &str,
    source: &RecordingSource,
    output_path: &Path,
) -> Result<Command> {
    let mut command = Command::new(ffmpeg_path);
    command.arg("-y");

    match source {
        RecordingSource::Microphone => {
            let microphone = detect_microphone_device(ffmpeg_path)?;
            command
                .args(["-f", "dshow", "-i"])
                .arg(format!("audio={microphone}"));
        }
        RecordingSource::SystemAudio => {
            let system_device = detect_system_audio_device(ffmpeg_path)?;
            command
                .args(["-f", "dshow", "-i"])
                .arg(format!("audio={system_device}"));
        }
        RecordingSource::Mixed => {
            let microphone = detect_microphone_device(ffmpeg_path)?;
            let system_device = detect_system_audio_device(ffmpeg_path)?;
            command
                .args(["-f", "dshow", "-i"])
                .arg(format!("audio={microphone}"))
                .args(["-f", "dshow", "-i"])
                .arg(format!("audio={system_device}"))
                .args([
                    "-filter_complex",
                    "[0:a][1:a]amix=inputs=2:weights='1 1':normalize=0",
                ]);
        }
        RecordingSource::ImportedFile => {
            return Err(anyhow!(
                "Imported files do not use the live recording backend."
            ));
        }
    }

    command.args(["-acodec", "pcm_s16le", "-ar", "44100", "-ac", "2"]);
    command.arg(output_path);
    Ok(command)
}

fn detect_microphone_device(ffmpeg_path: &str) -> Result<String> {
    let devices = list_audio_devices(ffmpeg_path)?;
    devices
        .iter()
        .find(|name| !looks_like_system_audio(name))
        .cloned()
        .ok_or_else(|| anyhow!("No microphone-like audio input device was found via ffmpeg dshow."))
}

fn detect_system_audio_device(ffmpeg_path: &str) -> Result<String> {
    let devices = list_audio_devices(ffmpeg_path)?;
    devices
        .iter()
        .find(|name| looks_like_system_audio(name))
        .cloned()
        .ok_or_else(|| {
            anyhow!(
                "No loopback-capable system audio input device was found. Import a file instead or install a loopback device such as Stereo Mix."
            )
        })
}

fn looks_like_system_audio(name: &str) -> bool {
    let normalized = name.to_ascii_lowercase();
    normalized.contains("stereo mix")
        || normalized.contains("what u hear")
        || normalized.contains("wave out")
        || normalized.contains("loopback")
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
