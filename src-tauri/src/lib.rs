mod commands;
mod watch;

use tauri::Manager;
use watch::WatchManager;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
  tauri::Builder::default()
    .plugin(tauri_plugin_dialog::init())
    .setup(|app| {
      if cfg!(debug_assertions) {
        app.handle().plugin(
          tauri_plugin_log::Builder::default()
            .level(log::LevelFilter::Info)
            .build(),
        )?;
      }
      app.manage(WatchManager::new(app.handle().clone()));
      Ok(())
    })
    .invoke_handler(tauri::generate_handler![
      commands::open_markdown_dialog,
      commands::open_path,
      commands::close_path,
    ])
    .run(tauri::generate_context!())
    .expect("error while running tauri application");
}
