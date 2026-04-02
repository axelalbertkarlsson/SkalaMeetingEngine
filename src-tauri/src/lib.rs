pub mod calendar;
pub mod commands;
pub mod meetings;

pub fn run() {
    tauri::Builder::default()
        .manage(commands::codex::CodexSessionState::default())
        .manage(commands::codex_app::CodexAppServerState::default())
        .manage(commands::meetings::MeetingRuntimeState::default())
        .invoke_handler(tauri::generate_handler![
            commands::calendar::list_calendar_sources,
            commands::calendar::import_calendar_source,
            commands::calendar::add_calendar_subscription,
            commands::calendar::remove_calendar_source,
            commands::calendar::load_calendar_source_snapshots,
            commands::meetings::import_meeting_file,
            commands::meetings::start_recording,
            commands::meetings::stop_recording,
            commands::meetings::list_meeting_runs,
            commands::meetings::get_meeting_run,
            commands::meetings::read_meeting_artifact,
            commands::meetings::delete_meeting_transcripts,
            commands::meetings::delete_meeting_run,
            commands::meetings::retranscribe_meeting_run,
            commands::meetings::open_meeting_artifact_location,
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
            commands::codex_app::codex_app_connect,
            commands::codex_app::codex_app_list_threads,
            commands::codex_app::codex_app_list_models,
            commands::codex_app::codex_app_read_config,
            commands::codex_app::codex_app_read_thread,
            commands::codex_app::codex_app_resume_thread,
            commands::codex_app::codex_app_start_thread,
            commands::codex_app::codex_app_archive_thread,
            commands::codex_app::codex_app_send_turn,
            commands::codex_app::codex_app_stop,
            commands::codex_app::codex_app_respond_to_server_request,
            commands::documents::documents_read_note,
            commands::documents::documents_write_note,
            commands::documents::documents_delete_note,
            commands::documents::documents_copy_note,
            commands::documents::documents_resolve_note_path,
            commands::documents::documents_stage_file_for_codex,
            commands::documents::documents_prepare_file_for_codex,
            commands::spellcheck::spellcheck_load_personal_dictionary,
            commands::spellcheck::spellcheck_add_personal_word,
            commands::spellcheck::spellcheck_remove_personal_word
        ])
        .run(tauri::generate_context!())
        .expect("failed to run Skala Meeting Engine");
}
