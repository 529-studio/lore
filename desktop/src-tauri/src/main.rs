#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use std::fs;
use std::net::{TcpListener, TcpStream};
use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};
use std::sync::Mutex;
use std::thread::sleep;
use std::time::Duration;
use tauri::{Manager, RunEvent, WebviewUrl, WebviewWindowBuilder};

struct Sidecar(Mutex<Option<Child>>);

fn resource(app: &tauri::AppHandle, rel: &str) -> PathBuf {
    if let Ok(dir) = app.path().resource_dir() {
        let candidate = dir.join(rel);
        if candidate.exists() {
            return candidate;
        }
    }
    // Development fallback: cargo run without a bundle.
    PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("..")
        .join("stage")
        .join(rel)
}

fn config_path() -> Option<PathBuf> {
    let home = std::env::var("HOME").ok()?;
    Some(PathBuf::from(home).join(".config").join("lore").join("desktop.json"))
}

fn saved_repo() -> Option<PathBuf> {
    let file = config_path()?;
    let raw = fs::read_to_string(file).ok()?;
    let value: serde_json::Value = serde_json::from_str(&raw).ok()?;
    let repo = value.get("repo")?.as_str()?;
    let path = PathBuf::from(repo);
    if path.join(".lore").exists() {
        Some(path)
    } else {
        None
    }
}

fn save_repo(repo: &Path) {
    if let Some(file) = config_path() {
        if let Some(parent) = file.parent() {
            let _ = fs::create_dir_all(parent);
        }
        let body = serde_json::json!({ "repo": repo.to_string_lossy() });
        let _ = fs::write(file, format!("{body}\n"));
    }
}

fn choose_repo() -> Option<PathBuf> {
    if let Ok(value) = std::env::var("LORE_REPO") {
        let path = PathBuf::from(value);
        if path.exists() {
            return Some(path);
        }
    }
    if let Some(path) = saved_repo() {
        return Some(path);
    }
    rfd::FileDialog::new()
        .set_title("Choose a repository for Lore")
        .pick_folder()
}

fn start_server(app: &tauri::AppHandle, repo: &Path) -> Result<String, String> {
    let node = {
        #[cfg(windows)]
        {
            resource(app, "runtime/node.exe")
        }
        #[cfg(not(windows))]
        {
            resource(app, "runtime/node")
        }
    };
    let cli = resource(app, "app").join("dist").join("cli.js");
    if !node.exists() || !cli.exists() {
        return Err(format!("missing runtime: {} / {}", node.display(), cli.display()));
    }

    if !repo.join(".lore").exists() {
        Command::new(&node)
            .arg(&cli)
            .arg("init")
            .current_dir(repo)
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .status()
            .map_err(|error| format!("lore init failed: {error}"))?;
    }

    // A fixed port is useful for debugging and for the packaging smoke test.
    let port = match std::env::var("LORE_UI_PORT").ok().and_then(|v| v.parse::<u16>().ok()) {
        Some(port) => port,
        None => {
            let listener = TcpListener::bind("127.0.0.1:0").map_err(|e| e.to_string())?;
            let port = listener.local_addr().map_err(|e| e.to_string())?.port();
            drop(listener);
            port
        }
    };

    let child = Command::new(&node)
        .arg(&cli)
        .arg("ui")
        .arg("--port")
        .arg(port.to_string())
        .current_dir(repo)
        .env("NO_COLOR", "1")
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .spawn()
        .map_err(|error| format!("lore ui failed: {error}"))?;

    for _ in 0..120 {
        if TcpStream::connect(("127.0.0.1", port)).is_ok() {
            if let Some(state) = app.try_state::<Sidecar>() {
                *state.0.lock().unwrap() = Some(child);
            }
            return Ok(format!("http://127.0.0.1:{port}"));
        }
        sleep(Duration::from_millis(100));
    }
    Err("the local server did not start in time".to_string())
}

fn main() {
    tauri::Builder::default()
        .manage(Sidecar(Mutex::new(None)))
        .setup(|app| {
            let repo = choose_repo().ok_or("no repository selected")?;
            save_repo(&repo);
            let url = start_server(&app.handle().clone(), &repo)?;
            let parsed: tauri::Url = url.parse().map_err(|e| format!("bad url: {e}"))?;
            WebviewWindowBuilder::new(app, "main", WebviewUrl::External(parsed))
                .title("Lore")
                .inner_size(1200.0, 820.0)
                .min_inner_size(900.0, 600.0)
                .build()?;
            Ok(())
        })
        .build(tauri::generate_context!())
        .expect("failed to build the app")
        .run(|app_handle, event| {
            if let RunEvent::Exit = event {
                if let Some(state) = app_handle.try_state::<Sidecar>() {
                    if let Some(mut child) = state.0.lock().unwrap().take() {
                        let _ = child.kill();
                    }
                }
            }
        });
}
