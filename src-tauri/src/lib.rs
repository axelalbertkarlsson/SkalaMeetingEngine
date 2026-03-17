pub mod commands;
pub mod meetings;

pub fn run() {
    tauri::Builder::default()
        .manage(commands::codex::CodexSessionState::default())
        .manage(commands::meetings::MeetingRuntimeState::default())
        .invoke_handler(tauri::generate_handler![
            commands::meetings::import_meeting_file,
            commands::meetings::start_recording,
            commands::meetings::stop_recording,
            commands::meetings::list_meeting_runs,
            commands::meetings::get_meeting_run,
            commands::meetings::retry_meeting_run,
            commands::meetings::get_transcription_settings,
            commands::meetings::save_transcription_settings,
            commands::codex::get_terminal_host_info,
            commands::codex::list_codex_capture_bundles,
            commands::codex::load_codex_capture_bundle,
            commands::codex::spawn_codex_process,
            commands::codex::record_codex_capture_events,
            commands::codex::send_codex_input,
            commands::codex::stop_codex_process,
            commands::codex::resize_codex_terminal,
            commands::documents::documents_read_note,
            commands::documents::documents_write_note,
            commands::documents::documents_delete_note,
            commands::documents::documents_copy_note
        ])
        .run(tauri::generate_context!())
        .expect("failed to run Skala Meeting Engine");
}
