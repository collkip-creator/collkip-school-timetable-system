#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use reqwest::blocking::Client;
use std::time::Duration;

#[tauri::command]
fn collkip_license_request(url: String, body: String) -> Result<String, String> {
    let client = Client::builder()
        .timeout(Duration::from_secs(12))
        .build()
        .map_err(|err| format!("Unable to create licensing client: {err}"))?;
    let parsed: serde_json::Value = serde_json::from_str(&body)
        .map_err(|err| format!("Invalid licensing request: {err}"))?;
    let response = client
        .post(url)
        .json(&parsed)
        .send()
        .map_err(|err| format!("Licensing service unavailable: {err}"))?;
    let status = response.status();
    let text = response
        .text()
        .map_err(|err| format!("Unable to read licensing response: {err}"))?;
    if !status.is_success() {
        return Err(text);
    }
    Ok(text)
}

fn main() {
    tauri::Builder::default()
        .plugin(tauri_plugin_sql::Builder::default().build())
        .invoke_handler(tauri::generate_handler![collkip_license_request])
        .run(tauri::generate_context!())
        .expect("error while running Collkip desktop application");
}
