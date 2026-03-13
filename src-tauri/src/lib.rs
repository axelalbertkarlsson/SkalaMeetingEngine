pub mod commands;

pub fn run() {
    tauri::Builder::default()
        .manage(commands::codex::CodexSessionState::default())
        .invoke_handler(tauri::generate_handler![
            commands::recording::start_recording,
            commands::recording::stop_recording,
            commands::transcription::create_transcription_job,
            commands::transcription::get_transcription_job_status,
            commands::codex::spawn_codex_process,
            commands::codex::send_codex_input,
            commands::codex::stop_codex_process,
            commands::codex::resize_codex_terminal
        ])
        .run(tauri::generate_context!())
        .expect("failed to run Skala Meeting Engine");
}
