use pake_blocker_core::{self as blocker, Blocker, Bundle, FilterList};
use serde::{Deserialize, Serialize};
use std::{path::PathBuf, sync::{Arc, Mutex, atomic::{AtomicBool, Ordering}}, time::{Duration, SystemTime, UNIX_EPOCH}};
use tauri::{Manager, WebviewWindow};
use windows::{core::{Interface, HSTRING, PWSTR}, Win32::UI::Shell::SHCreateMemStream};
use webview2_com::{Microsoft::Web::WebView2::Win32::*, take_pwstr, WebResourceRequestedEventHandler, AddScriptToExecuteOnDocumentCreatedCompletedHandler};

#[derive(Clone)]
pub struct State(pub Arc<Mutex<Service>>);
pub struct Service {
    engine: Blocker, enabled: bool, cache_dir: PathBuf,
    checked: u64, blocked: u64, redirected: u64, last_rule: Option<String>,
    runtime: String, cache_loaded: bool, script_ready: bool, script_id: Option<String>, adapter_error: Option<String>,
}
static UPDATING: AtomicBool = AtomicBool::new(false);
#[derive(Serialize)]
pub struct Status {
    enabled: bool, engine: &'static str, filters: String, fingerprint: String, runtime: String,
    checked: u64, blocked: u64, redirected: u64, last_rule: Option<String>,
    cache_loaded: bool, script_ready: bool, adapter_error: Option<String>,
}
#[derive(Serialize, Deserialize)]
struct Settings { enabled: bool }
impl Service {
    fn document_script(&self, enabled: bool) -> String {
        // Native preference is authoritative across all supported YouTube origins.
        let setting=format!("try{{localStorage.setItem('pake-adblock-enabled','{}')}}catch{{}};",if enabled {"1"} else {"0"});
        let engine_script=if enabled { self.engine.document_script() } else { String::new() };
        format!("(()=>{{if(!['youtube.com','www.youtube.com','m.youtube.com','music.youtube.com','youtube-nocookie.com','www.youtube-nocookie.com'].includes(location.hostname)||location.protocol!=='https:')return;{}\n{}\n{}\n}})();",setting,engine_script,include_str!("../pake-adblock/ui.js"))
    }
    fn status(&self) -> Status { Status {
        enabled:self.enabled, engine:blocker::ENGINE_VERSION, filters:self.engine.version.clone(),
        fingerprint:self.engine.fingerprint.clone(), runtime:self.runtime.clone(), checked:self.checked,
        blocked:self.blocked, redirected:self.redirected, last_rule:self.last_rule.clone(),
        cache_loaded:self.cache_loaded, script_ready:self.script_ready, adapter_error:self.adapter_error.clone(),
    } }
}
pub fn initialize(app: &tauri::AppHandle) -> Result<(), Box<dyn std::error::Error>> {
    // Same product-name profile as the existing YouTube app; never delete its contents.
    let name=app.config().product_name.clone().unwrap_or_else(||"YouTube".into());
    let dir=crate::util::get_data_dir(app,name)?.join("pake-adblock");
    let (engine, cache_loaded)=blocker::load_cached_or_baseline(&dir.join("bundle.json")).map_err(std::io::Error::other)?;
    let enabled=std::fs::read(dir.join("settings.json")).ok()
        .and_then(|v|serde_json::from_slice::<Settings>(&v).ok()).map(|v|v.enabled).unwrap_or(true);
    app.manage(State(Arc::new(Mutex::new(Service { engine, enabled, cache_dir:dir,
        checked:0,blocked:0,redirected:0,last_rule:None,runtime:String::new(),
        cache_loaded,script_ready:false,script_id:None,adapter_error:None }))));
    Ok(())
}
fn authorize(window: &WebviewWindow) -> Result<(), String> {
    if window.label()!="pake" || !window.url().is_ok_and(|u|blocker::is_youtube(u.as_str())) {
        return Err("Blocker controls are only available in the YouTube window".into());
    }
    Ok(())
}
#[tauri::command]
pub fn blocker_status(window: WebviewWindow, state: tauri::State<State>) -> Result<Status,String> {
    authorize(&window)?; Ok(state.0.lock().map_err(|_|"Blocker unavailable")?.status())
}
#[tauri::command]
pub async fn blocker_set_enabled(window: WebviewWindow, state: tauri::State<'_,State>, enabled: bool) -> Result<Status,String> {
    authorize(&window)?;
    let state=state.inner().clone();
    let (tx,rx)=tokio::sync::oneshot::channel();
    window.with_webview(move |webview| unsafe {
        let core=match webview.controller().CoreWebView2() {Ok(core)=>core,Err(e)=>{let _=tx.send(Err(e.to_string()));return}};
        let script=state.0.lock().unwrap().document_script(enabled);
        let callback_core=core.clone();
        // Install the next-document script before allowing the UI to reload.
        // Existing script + preference survive any registration/save failure.
        let _=core.AddScriptToExecuteOnDocumentCreated(&HSTRING::from(script),
            &AddScriptToExecuteOnDocumentCreatedCompletedHandler::create(Box::new(move |result,id| {
                let result=result.map_err(|e|e.to_string()).and_then(|_| {
                    let mut service=state.0.lock().map_err(|_|"Blocker unavailable")?;
                    if let Err(e)=blocker::atomic_save(&service.cache_dir.join("settings.json"),&serde_json::to_vec(&Settings{enabled}).unwrap()) {
                        let _=callback_core.RemoveScriptToExecuteOnDocumentCreated(&HSTRING::from(id));
                        return Err(e);
                    }
                    if let Some(old)=service.script_id.replace(id) { let _=callback_core.RemoveScriptToExecuteOnDocumentCreated(&HSTRING::from(old)); }
                    service.enabled=enabled; service.script_ready=true;
                    Ok(service.status())
                });
                let _=tx.send(result); Ok(())
            })));
    }).map_err(|e|e.to_string())?;
    tokio::time::timeout(Duration::from_secs(10),rx).await.map_err(|_|"Script update timed out; restart the app")?
        .map_err(|_|"Script update failed; existing settings retained")?
}
#[tauri::command]
pub async fn blocker_update(window: WebviewWindow, state: tauri::State<'_,State>) -> Result<String,String> {
    authorize(&window)?;
    if UPDATING.swap(true,Ordering::AcqRel) { return Err("An update is already running".into()); }
    struct Reset; impl Drop for Reset { fn drop(&mut self) { UPDATING.store(false,Ordering::Release); } }
    let _reset=Reset;
    let dir=state.0.lock().map_err(|_|"Blocker unavailable")?.cache_dir.clone();
    let client=tauri_plugin_http::reqwest::Client::builder().timeout(Duration::from_secs(25))
        .https_only(true).build().map_err(|_|"Cannot initialize update client")?;
    async fn download(client:&tauri_plugin_http::reqwest::Client, url:&str, limit:usize) -> Result<String,String> {
        let mut response=client.get(url).send().await.map_err(|_|"Filter download failed; current filters retained")?
            .error_for_status().map_err(|_|"Filter server returned an error; current filters retained")?;
        if response.content_length().is_some_and(|n|n>limit as u64) { return Err("Update exceeds size limit".into()); }
        let mut bytes=Vec::new();
        while let Some(chunk)=response.chunk().await.map_err(|_|"Incomplete update download")? {
            if bytes.len()+chunk.len()>limit { return Err("Update exceeds size limit".into()); }
            bytes.extend_from_slice(&chunk);
        }
        String::from_utf8(bytes).map_err(|_|"Invalid update encoding".into())
    }
    let mut lists=Vec::new();
    for (name,url) in blocker::LIST_URLS { lists.push(FilterList { name:(*name).into(),text:download(&client,url,8_000_000).await? }); }
    let resources=serde_json::from_str(&download(&client,blocker::RESOURCE_URL,4_000_000).await?).map_err(|_|"Invalid resource JSON")?;
    let version=format!("updated-{}",SystemTime::now().duration_since(UNIX_EPOCH).unwrap_or_default().as_secs());
    let bundle=Bundle {schema:1,version,lists,resources};
    // Validate and save off the UI thread. One atomic bundle keeps rules and resources together.
    tauri::async_runtime::spawn_blocking(move || {
        Blocker::from_bundle(&bundle)?;
        blocker::atomic_save(&dir.join("bundle.json"),&serde_json::to_vec(&bundle).map_err(|e|e.to_string())?)?;
        Ok::<_,String>("Filters saved. Restart YouTube to apply the complete bundle.".into())
    }).await.map_err(|_|"Filter validation failed; current filters retained")?
}
fn resource_kind(context: COREWEBVIEW2_WEB_RESOURCE_CONTEXT) -> &'static str {
    match context {
        COREWEBVIEW2_WEB_RESOURCE_CONTEXT_DOCUMENT => "document",
        COREWEBVIEW2_WEB_RESOURCE_CONTEXT_STYLESHEET => "stylesheet",
        COREWEBVIEW2_WEB_RESOURCE_CONTEXT_IMAGE => "image",
        COREWEBVIEW2_WEB_RESOURCE_CONTEXT_MEDIA => "media",
        COREWEBVIEW2_WEB_RESOURCE_CONTEXT_FONT => "font",
        COREWEBVIEW2_WEB_RESOURCE_CONTEXT_SCRIPT => "script",
        COREWEBVIEW2_WEB_RESOURCE_CONTEXT_XML_HTTP_REQUEST | COREWEBVIEW2_WEB_RESOURCE_CONTEXT_FETCH => "xmlhttprequest",
        COREWEBVIEW2_WEB_RESOURCE_CONTEXT_PING => "ping",
        COREWEBVIEW2_WEB_RESOURCE_CONTEXT_WEBSOCKET => "websocket",
        _ => "other",
    }
}
pub fn install(window:&WebviewWindow, target: String) -> tauri::Result<()> {
    let state=window.state::<State>().inner().clone();
    window.with_webview(move |webview| {
        let fallback=target.clone();
        let result=(|| -> windows::core::Result<()> {
            unsafe {
                let core=webview.controller().CoreWebView2()?;
                let env=webview.environment();
                let mut runtime=PWSTR::null(); env.BrowserVersionString(&mut runtime)?;
                state.0.lock().unwrap().runtime=take_pwstr(runtime);
                // Newer API covers worker/iframe request sources; older runtimes fall back.
                if let Ok(core22)=core.cast::<ICoreWebView2_22>() {
                    core22.AddWebResourceRequestedFilterWithRequestSourceKinds(&HSTRING::from("*"),
                        COREWEBVIEW2_WEB_RESOURCE_CONTEXT_ALL, COREWEBVIEW2_WEB_RESOURCE_REQUEST_SOURCE_KINDS_ALL)?;
                } else {
                    core.AddWebResourceRequestedFilter(&HSTRING::from("*"),COREWEBVIEW2_WEB_RESOURCE_CONTEXT_ALL)?;
                }
                let requests=state.clone();
                let mut token=0;
                core.add_WebResourceRequested(&WebResourceRequestedEventHandler::create(Box::new(move |sender,args| {
                    let (Some(sender),Some(args))=(sender,args) else {return Ok(())};
                    let request=args.Request()?;
                    let mut uri=PWSTR::null(); request.Uri(&mut uri)?; let uri=take_pwstr(uri);
                    if !uri.starts_with("https://") && !uri.starts_with("http://") {return Ok(())}
                    let mut source=PWSTR::null();
                    let headers=request.Headers()?;
                    let source=if headers.GetHeader(&HSTRING::from("Referer"),&mut source).is_ok() {
                        take_pwstr(source)
                    } else {
                        if !source.is_null() {let _=take_pwstr(source);}
                        let mut source=PWSTR::null(); sender.Source(&mut source)?; take_pwstr(source)
                    };
                    let mut method=PWSTR::null(); request.Method(&mut method)?; let method=take_pwstr(method);
                    let mut context=COREWEBVIEW2_WEB_RESOURCE_CONTEXT_ALL; args.ResourceContext(&mut context)?;
                    let mut service=requests.0.lock().unwrap();
                    if !service.enabled || !blocker::is_youtube(&source) {return Ok(())}
                    service.checked+=1;
                    let decision=service.engine.decide_method(&uri,&source,resource_kind(context),&method);
                    if !decision.blocked {return Ok(())}
                    service.blocked+=1; service.last_rule=decision.rule_id;
                    let (mime,body,status)=if let Some((mime,body))=decision.redirect {
                        service.redirected+=1; (mime,body,200)
                    } else {("text/plain".into(),Vec::new(),403)};
                    drop(service);
                    let stream=SHCreateMemStream(Some(&body));
                    let response=env.CreateWebResourceResponse(stream.as_ref(),status,
                        &HSTRING::from(if status==200 {"OK"} else {"Blocked"}),
                        &HSTRING::from(format!("Content-Type: {mime}\r\nCache-Control: no-store\r\nAccess-Control-Allow-Origin: *")))?;
                    args.SetResponse(&response)?;
                    Ok(())
                })),&mut token)?;
                // COM keeps registered handlers alive for the webview lifetime. No per-request I/O.
                let service=state.0.lock().unwrap();
                let script=service.document_script(service.enabled);
                drop(service);
                let navigate_core=core.clone(); let completed_state=state.clone();
                core.AddScriptToExecuteOnDocumentCreated(&HSTRING::from(script),
                    &AddScriptToExecuteOnDocumentCreatedCompletedHandler::create(Box::new(move |result,id| {
                        let mut service=completed_state.0.lock().unwrap();
                        service.script_ready=result.is_ok();
                        if result.is_ok() {service.script_id=Some(id);}
                        if result.is_err() {service.adapter_error=Some("Early script registration failed".into());}
                        drop(service);
                        // Navigate only after registration completes, even if it failed (fail open).
                        navigate_core.Navigate(&HSTRING::from(&target))?;
                        result
                    })))?;
                Ok(())
            }
        })();
        if let Err(error)=result {
            state.0.lock().unwrap().adapter_error=Some(format!("Adapter initialization failed: {error}"));
            // A failed integration must not strand the app on about:blank.
            unsafe { if let Ok(core)=webview.controller().CoreWebView2() {let _=core.Navigate(&HSTRING::from(&fallback));} }
        }
    })
}
