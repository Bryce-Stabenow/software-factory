#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use std::{io::{BufRead, BufReader, Write, Read}, path::{Path, PathBuf}, process::{Child, ChildStdin, Command, Stdio}, sync::{mpsc, Arc, Mutex, atomic::{AtomicBool, Ordering}}, time::Duration};
use tauri::{Manager, State};

type Reply = Result<serde_json::Value, String>;
struct Request { command: serde_json::Value, reply: mpsc::Sender<Reply> }
struct Launch { node: PathBuf, entry: PathBuf, cwd: PathBuf, data: PathBuf, path: String, packaged: bool }
struct Bridge { sender: mpsc::Sender<Request>, child: Mutex<Child>, input: Arc<Mutex<Option<ChildStdin>>>, stopped: AtomicBool }
impl Bridge {
    fn spawn(config: &Launch) -> Result<Arc<Self>, String> {
        std::fs::create_dir_all(&config.data).map_err(|_| "Cannot create the application data folder.")?;
        let mut launch = Command::new(&config.node);
        launch.arg(&config.entry).current_dir(&config.cwd).env_clear()
            .env("PATH", &config.path).env("HOME", std::env::var("HOME").unwrap_or_default())
            .env("FACTORY_DATA_DIR", &config.data).env("FACTORY_PACKAGED", if config.packaged { "1" } else { "0" })
            .stdin(Stdio::piped()).stdout(Stdio::piped()).stderr(Stdio::null());
        if !config.packaged { launch.env("FACTORY_DEMO", "1"); }
        for key in ["CODEX_HOME", "FACTORY_CODEX_BINARY", "FACTORY_WORKSPACE_ROOT", "TMPDIR", "LANG", "USER", "LOGNAME", "SSH_AUTH_SOCK"] {
            if let Ok(value) = std::env::var(key) { launch.env(key, value); }
        }
        let mut child = launch.spawn().map_err(|_| "The bundled factory service could not start. Reinstall the app or check its runtime resources.")?;
        let input = Arc::new(Mutex::new(child.stdin.take()));
        let mut output = BufReader::new(child.stdout.take().ok_or("Missing service output.")?);
        let (sender, receiver) = mpsc::channel::<Request>();
        let writer = input.clone();
        std::thread::spawn(move || {
            for request in receiver {
                let result = (|| -> Reply {
                    let encoded = serde_json::to_string(&request.command).map_err(|_| "Invalid command.")?;
                    if encoded.len() > 1024 * 1024 { return Err("Command exceeds 1 MiB.".into()); }
                    {
                        let mut input = writer.lock().map_err(|_| "Factory connection unavailable.")?;
                        let input = input.as_mut().ok_or("Factory service stopped. Use Restart service in Settings.")?;
                        writeln!(input, "{}", encoded).and_then(|_| input.flush()).map_err(|_| "Factory service disconnected. Use Restart service in Settings.")?;
                    }
                    let mut line = String::new();
                    let size = output.by_ref().take(64 * 1024 * 1024 + 1).read_line(&mut line).map_err(|_| "Cannot read factory response.")?;
                    if size == 0 { return Err("Factory service stopped. Use Restart service in Settings. Another app may already own this data folder.".into()); }
                    if size > 64 * 1024 * 1024 { return Err("Factory response exceeded 64 MiB. Restart service and export diagnostics.".into()); }
                    serde_json::from_str(&line).map_err(|_| "Invalid factory service response. Restart the service.".into())
                })();
                let failed = result.is_err();
                let _ = request.reply.send(result);
                if failed { break; }
            }
        });
        Ok(Arc::new(Self { sender, child: Mutex::new(child), input, stopped: AtomicBool::new(false) }))
    }
    fn request(&self, command: serde_json::Value) -> Reply {
        if self.stopped.load(Ordering::SeqCst) { return Err("Factory service stopped. Restart it in Settings.".into()); }
        let (reply, result) = mpsc::channel();
        self.sender.send(Request { command, reply }).map_err(|_| "Factory service disconnected. Restart it in Settings.")?;
        result.recv_timeout(Duration::from_secs(45)).map_err(|_| "Factory response timed out. Inspect running work, then restart the service if needed.".to_string())?
    }
    fn stop(&self) {
        if self.stopped.swap(true, Ordering::SeqCst) { return; }
        if let Ok(mut input) = self.input.lock() { input.take(); }
        if let Ok(mut child) = self.child.lock() {
            for _ in 0..500 {
                if matches!(child.try_wait(), Ok(Some(_))) { return; }
                std::thread::sleep(Duration::from_millis(10));
            }
            let _ = child.kill(); let _ = child.wait();
        }
    }
}
impl Drop for Bridge { fn drop(&mut self) { self.stop(); } }
struct Factory { bridge: Mutex<Option<Arc<Bridge>>>, launch: Launch }

#[tauri::command]
async fn factory_command(command: serde_json::Value, state: State<'_, Arc<Factory>>) -> Reply {
    let bridge = state.bridge.lock().map_err(|_| "Factory connection unavailable.")?.clone().ok_or("Factory service unavailable. Restart it in Settings.")?;
    tauri::async_runtime::spawn_blocking(move || bridge.request(command)).await.map_err(|_| "Factory command interrupted.".to_string())?
}
#[tauri::command]
async fn factory_restart(state: State<'_, Arc<Factory>>) -> Result<(), String> {
    let factory = state.inner().clone();
    tauri::async_runtime::spawn_blocking(move || {
        let mut current = factory.bridge.lock().map_err(|_| "Factory connection unavailable.")?;
        if let Some(old) = current.take() { old.stop(); }
        *current = Some(Bridge::spawn(&factory.launch)?);
        Ok(())
    }).await.map_err(|_| "Service restart interrupted.".to_string())?
}
#[tauri::command]
fn factory_webview_error(message: String) {
    if std::env::var("FACTORY_NATIVE_DEBUG").as_deref() == Ok("1") { eprintln!("Webview error: {}", message.chars().take(1000).collect::<String>()); }
}
fn tool_path(node: &Path) -> String {
    let mut paths = vec![];
    if let Some(parent) = node.parent().filter(|path| !path.as_os_str().is_empty()) { paths.push(parent.to_path_buf()); }
    if let Some(value) = std::env::var_os("PATH") { paths.extend(std::env::split_paths(&value)); }
    if let Some(home) = std::env::var_os("HOME") {
        let home = PathBuf::from(home);
        paths.push(home.join(".local/bin")); paths.push(home.join(".cargo/bin"));
        if let Ok(versions) = std::fs::read_dir(home.join(".nvm/versions/node")) {
            let mut bins: Vec<_> = versions.flatten().filter(|entry| entry.path().is_dir()).map(|entry| entry.path().join("bin")).collect();
            bins.sort(); bins.reverse(); paths.extend(bins);
        }
    }
    paths.extend(["/opt/homebrew/bin", "/usr/local/bin", "/usr/bin", "/bin", "/usr/sbin", "/sbin"].map(PathBuf::from));
    std::env::join_paths(paths).unwrap_or_default().to_string_lossy().into_owned()
}
fn main() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .append_invoke_initialization_script(if std::env::var("FACTORY_NATIVE_DEBUG").as_deref() == Ok("1") { r#"const factoryConsoleError = console.error.bind(console); console.error = (...args) => { window.__TAURI_INTERNALS__.invoke('factory_webview_error', {message: args.map(arg => arg instanceof Error ? arg.stack : typeof arg === 'string' ? arg : typeof arg).join(' ')}).catch(()=>{}); factoryConsoleError(...args); }; window.addEventListener('securitypolicyviolation', event => { window.__TAURI_INTERNALS__.invoke('factory_webview_error',{message:'CSP ' + event.violatedDirective + ' ' + event.blockedURI}).catch(()=>{}); }); window.addEventListener('error', event => { window.__TAURI_INTERNALS__.invoke('factory_webview_error', {message: String(event.message || 'Resource load failed') + ' ' + (event.filename || event.target?.src || '')}).catch(()=>{}); }, true); window.addEventListener('unhandledrejection', event => { window.__TAURI_INTERNALS__.invoke('factory_webview_error', {message: String(event.reason)}).catch(()=>{}); });"# } else { "" })
        .setup(|app| {
            let packaged = !cfg!(debug_assertions);
            let root = Path::new(env!("CARGO_MANIFEST_DIR")).join("../../..");
            let resources = app.path().resource_dir()?.join("companion");
            let (node, entry, cwd) = if packaged { (resources.join("runtime/node"), resources.join("dist/apps/factory-service/src/main.js"), resources) }
                else { (PathBuf::from("node"), root.join("dist/apps/factory-service/src/main.js"), root.clone()) };
            let data = std::env::var_os("FACTORY_DATA_DIR").map(PathBuf::from).unwrap_or(if packaged { app.path().app_data_dir()? } else { root.join(".factory/desktop") });
            let path = tool_path(&node);
            let launch = Launch { node, entry, cwd, data, path, packaged };
            let bridge = Bridge::spawn(&launch).ok();
            app.manage(Arc::new(Factory { bridge: Mutex::new(bridge), launch }));
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![factory_command, factory_restart, factory_webview_error])
        .on_window_event(|window, event| {
            if let tauri::WindowEvent::CloseRequested { .. } = event { window.app_handle().exit(0); }
        })
        .build(tauri::generate_context!())
        .expect("Unable to start Kulumin")
        .run(|app, event| {
            if let tauri::RunEvent::Exit = event {
                if let Some(factory) = app.try_state::<Arc<Factory>>() {
                    if let Ok(mut bridge) = factory.bridge.lock() { if let Some(bridge) = bridge.take() { bridge.stop(); } }
                }
            }
        });
}
