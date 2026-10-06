use block2::RcBlock;
use objc2::{class, msg_send, runtime::AnyObject, MainThreadMarker};
use objc2_foundation::{NSError, NSString};
use objc2_web_kit::{WKContentRuleList, WKContentRuleListStore, WKWebView};
use pake_blocker_core::{self as blocker, Blocker, Bundle, FilterList};
use serde::{Deserialize, Serialize};
use std::{
    path::PathBuf,
    sync::{
        atomic::{AtomicBool, Ordering},
        Arc, Mutex,
    },
    time::{Duration, SystemTime, UNIX_EPOCH},
};
use tauri::{Manager, WebviewWindow};

// WKContentRuleList covers request classes that WebKit exposes to applications.
// The shared adblock-rust engine still supplies uBO scriptlets, response pruning,
// and cosmetic rules at document start. Keep this native list deliberately
// narrow: YouTube video media and player API responses must never be blocked.
const CONTENT_RULES: &str = r#"[
  {"trigger":{"url-filter":"^https?://([^/]+\\.)?doubleclick\\.net/","if-domain":["*youtube.com","*youtube-nocookie.com"]},"action":{"type":"block"}},
  {"trigger":{"url-filter":"^https?://([^/]+\\.)?googlesyndication\\.com/","if-domain":["*youtube.com","*youtube-nocookie.com"]},"action":{"type":"block"}},
  {"trigger":{"url-filter":"^https?://([^/]+\\.)?googleadservices\\.com/","if-domain":["*youtube.com","*youtube-nocookie.com"]},"action":{"type":"block"}},
  {"trigger":{"url-filter":"^https?://([^/]+\\.)?youtube\\.com/pagead/","if-domain":["*youtube.com","*youtube-nocookie.com"]},"action":{"type":"block"}},
  {"trigger":{"url-filter":"^https?://([^/]+\\.)?youtube\\.com/api/stats/ads","if-domain":["*youtube.com","*youtube-nocookie.com"]},"action":{"type":"block"}},
  {"trigger":{"url-filter":"^https?://([^/]+\\.)?youtube\\.com/ptracking","if-domain":["*youtube.com","*youtube-nocookie.com"]},"action":{"type":"block"}},
  {"trigger":{"url-filter":"^https?://([^/]+\\.)?youtube\\.com/get_midroll_info","if-domain":["*youtube.com","*youtube-nocookie.com"]},"action":{"type":"block"}}
]"#;
const RULE_LIST_ID: &str = "com.pake.youtube.blocker.network.v1";

#[derive(Clone)]
pub struct State(pub Arc<Mutex<Service>>);

pub struct Service {
    engine: Blocker,
    enabled: bool,
    cache_dir: PathBuf,
    runtime: String,
    cache_loaded: bool,
    script_ready: bool,
    adapter_error: Option<String>,
}

static UPDATING: AtomicBool = AtomicBool::new(false);

#[derive(Serialize)]
pub struct Status {
    enabled: bool,
    engine: &'static str,
    filters: String,
    fingerprint: String,
    runtime: String,
    checked: u64,
    blocked: u64,
    redirected: u64,
    last_rule: Option<String>,
    cache_loaded: bool,
    script_ready: bool,
    adapter_error: Option<String>,
}

#[derive(Serialize, Deserialize)]
struct Settings {
    enabled: bool,
}

impl Service {
    fn document_script(&self) -> String {
        let setting = format!(
            "try{{localStorage.setItem('pake-adblock-enabled','{}')}}catch{{}};",
            if self.enabled { "1" } else { "0" }
        );
        let engine_script = if self.enabled {
            self.engine.document_script()
        } else {
            String::new()
        };
        format!(
            "(()=>{{if(!['youtube.com','www.youtube.com','m.youtube.com','music.youtube.com','youtube-nocookie.com','www.youtube-nocookie.com'].includes(location.hostname)||location.protocol!=='https:')return;{}\n{}\n{}\n}})();",
            setting,
            engine_script,
            include_str!("../pake-adblock/ui.js")
        )
    }

    fn status(&self) -> Status {
        Status {
            enabled: self.enabled,
            engine: blocker::ENGINE_VERSION,
            filters: self.engine.version.clone(),
            fingerprint: self.engine.fingerprint.clone(),
            runtime: self.runtime.clone(),
            // WebKit content rules intentionally do not expose per-request matches.
            checked: 0,
            blocked: 0,
            redirected: 0,
            last_rule: None,
            cache_loaded: self.cache_loaded,
            script_ready: self.script_ready,
            adapter_error: self.adapter_error.clone(),
        }
    }
}

pub fn initialize(app: &tauri::AppHandle) -> Result<(), Box<dyn std::error::Error>> {
    let name = app
        .config()
        .product_name
        .clone()
        .unwrap_or_else(|| "YouTube".into());
    let dir = crate::util::get_data_dir(app, name)?.join("pake-adblock");
    let (engine, cache_loaded) = blocker::load_cached_or_baseline(&dir.join("bundle.json"))
        .map_err(std::io::Error::other)?;
    let enabled = std::fs::read(dir.join("settings.json"))
        .ok()
        .and_then(|value| serde_json::from_slice::<Settings>(&value).ok())
        .map(|settings| settings.enabled)
        .unwrap_or(true);
    app.manage(State(Arc::new(Mutex::new(Service {
        engine,
        enabled,
        cache_dir: dir,
        runtime: "WKWebView + WKContentRuleList".into(),
        cache_loaded,
        script_ready: true,
        adapter_error: None,
    }))));
    Ok(())
}

pub fn document_script(app: &tauri::AppHandle) -> Option<String> {
    app.try_state::<State>()?
        .0
        .lock()
        .ok()
        .map(|service| service.document_script())
}

fn authorize(window: &WebviewWindow) -> Result<(), String> {
    if window.label() != "pake"
        || !window
            .url()
            .is_ok_and(|url| blocker::is_youtube(url.as_str()))
    {
        return Err("Blocker controls are only available in the YouTube window".into());
    }
    Ok(())
}

fn persist_enabled(state: &State, enabled: bool) -> Result<Status, String> {
    let mut service = state.0.lock().map_err(|_| "Blocker unavailable")?;
    blocker::atomic_save(
        &service.cache_dir.join("settings.json"),
        &serde_json::to_vec(&Settings { enabled }).map_err(|error| error.to_string())?,
    )?;
    service.enabled = enabled;
    service.script_ready = true;
    service.adapter_error = None;
    Ok(service.status())
}

unsafe fn navigate(webview: &WKWebView, target: &str) -> bool {
    let target = NSString::from_str(target);
    let url: *mut AnyObject = unsafe { msg_send![class!(NSURL), URLWithString: &*target] };
    if url.is_null() {
        return false;
    }
    let request: *mut AnyObject = unsafe { msg_send![class!(NSURLRequest), requestWithURL: url] };
    if request.is_null() {
        return false;
    }
    let _: *mut AnyObject = unsafe { msg_send![webview, loadRequest: request] };
    true
}

#[tauri::command]
pub fn blocker_status(window: WebviewWindow, state: tauri::State<State>) -> Result<Status, String> {
    authorize(&window)?;
    Ok(state.0.lock().map_err(|_| "Blocker unavailable")?.status())
}

#[tauri::command]
pub fn blocker_focus_webview(window: WebviewWindow) -> Result<(), String> {
    authorize(&window)?;
    window.set_focus().map_err(|error| error.to_string())?;
    window
        .with_webview(|webview| unsafe {
            let webview = &*(webview.inner() as *const WKWebView);
            let native_window: *mut AnyObject = msg_send![webview, window];
            if !native_window.is_null() {
                let _: () = msg_send![native_window, makeKeyWindow];
                let _: bool = msg_send![native_window, makeFirstResponder: webview];
            }
        })
        .map_err(|error| error.to_string())
}

#[tauri::command]
pub async fn blocker_set_enabled(
    window: WebviewWindow,
    state: tauri::State<'_, State>,
    enabled: bool,
) -> Result<Status, String> {
    authorize(&window)?;
    let state = state.inner().clone();
    let (sender, receiver) = tokio::sync::oneshot::channel();
    let sender = Arc::new(Mutex::new(Some(sender)));
    let operation_state = state.clone();
    window
        .with_webview(move |webview| unsafe {
            let webview = &*(webview.inner() as *const WKWebView);
            let controller = webview.configuration().userContentController();
            controller.removeAllContentRuleLists();

            if !enabled {
                let result = persist_enabled(&operation_state, false);
                if let Some(sender) = sender.lock().ok().and_then(|mut value| value.take()) {
                    let _ = sender.send(result);
                }
                return;
            }

            let Some(mtm) = MainThreadMarker::new() else {
                if let Some(sender) = sender.lock().ok().and_then(|mut value| value.take()) {
                    let _ = sender.send(Err("WebKit content rules require the main thread".into()));
                }
                return;
            };
            let Some(store) = WKContentRuleListStore::defaultStore(mtm) else {
                if let Some(sender) = sender.lock().ok().and_then(|mut value| value.take()) {
                    let _ = sender.send(Err("WebKit content rule store is unavailable".into()));
                }
                return;
            };
            let identifier = NSString::from_str(RULE_LIST_ID);
            let encoded = NSString::from_str(CONTENT_RULES);
            let completion_sender = sender.clone();
            let completion: RcBlock<dyn Fn(*mut WKContentRuleList, *mut NSError)> = RcBlock::new(
                move |rule_list: *mut WKContentRuleList, error: *mut NSError| {
                    let result = if !error.is_null() || rule_list.is_null() {
                        Err("WebKit could not compile the network blocker".into())
                    } else {
                        controller.addContentRuleList(&*rule_list);
                        persist_enabled(&operation_state, true)
                    };
                    if let Some(sender) = completion_sender
                        .lock()
                        .ok()
                        .and_then(|mut value| value.take())
                    {
                        let _ = sender.send(result);
                    }
                },
            );
            store.compileContentRuleListForIdentifier_encodedContentRuleList_completionHandler(
                Some(&identifier),
                Some(&encoded),
                Some(&completion),
            );
        })
        .map_err(|error| error.to_string())?;
    tokio::time::timeout(Duration::from_secs(10), receiver)
        .await
        .map_err(|_| "Network blocker update timed out; restart the app")?
        .map_err(|_| "Network blocker update was interrupted")?
}

#[tauri::command]
pub async fn blocker_update(
    window: WebviewWindow,
    state: tauri::State<'_, State>,
) -> Result<String, String> {
    authorize(&window)?;
    if UPDATING.swap(true, Ordering::AcqRel) {
        return Err("An update is already running".into());
    }
    struct Reset;
    impl Drop for Reset {
        fn drop(&mut self) {
            UPDATING.store(false, Ordering::Release);
        }
    }
    let _reset = Reset;
    let dir = state
        .0
        .lock()
        .map_err(|_| "Blocker unavailable")?
        .cache_dir
        .clone();
    let client = tauri_plugin_http::reqwest::Client::builder()
        .timeout(Duration::from_secs(25))
        .https_only(true)
        .build()
        .map_err(|_| "Cannot initialize update client")?;

    async fn download(
        client: &tauri_plugin_http::reqwest::Client,
        url: &str,
        limit: usize,
    ) -> Result<String, String> {
        let mut response = client
            .get(url)
            .send()
            .await
            .map_err(|_| "Filter download failed; current filters retained")?
            .error_for_status()
            .map_err(|_| "Filter server returned an error; current filters retained")?;
        if response
            .content_length()
            .is_some_and(|size| size > limit as u64)
        {
            return Err("Update exceeds size limit".into());
        }
        let mut bytes = Vec::new();
        while let Some(chunk) = response
            .chunk()
            .await
            .map_err(|_| "Incomplete update download")?
        {
            if bytes.len() + chunk.len() > limit {
                return Err("Update exceeds size limit".into());
            }
            bytes.extend_from_slice(&chunk);
        }
        String::from_utf8(bytes).map_err(|_| "Invalid update encoding".into())
    }

    let mut lists = Vec::new();
    for (name, url) in blocker::LIST_URLS {
        lists.push(FilterList {
            name: (*name).into(),
            text: download(&client, url, 8_000_000).await?,
        });
    }
    let resources =
        serde_json::from_str(&download(&client, blocker::RESOURCE_URL, 4_000_000).await?)
            .map_err(|_| "Invalid resource JSON")?;
    let version = format!(
        "updated-{}",
        SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap_or_default()
            .as_secs()
    );
    let bundle = Bundle {
        schema: 1,
        version,
        lists,
        resources,
    };
    tauri::async_runtime::spawn_blocking(move || {
        Blocker::from_bundle(&bundle)?;
        blocker::atomic_save(
            &dir.join("bundle.json"),
            &serde_json::to_vec(&bundle).map_err(|error| error.to_string())?,
        )?;
        Ok::<_, String>("Filters saved. Restart YouTube to apply the complete bundle.".into())
    })
    .await
    .map_err(|_| "Filter validation failed; current filters retained")?
}

pub fn install(window: &WebviewWindow, target: String) -> tauri::Result<()> {
    let state = window.state::<State>().inner().clone();
    let install_state = state.clone();
    window.with_webview(move |webview| unsafe {
        let webview = &*(webview.inner() as *const WKWebView);
        let controller = webview.configuration().userContentController();
        controller.removeAllContentRuleLists();
        let enabled = install_state
            .0
            .lock()
            .map(|service| service.enabled)
            .unwrap_or(true);
        if !enabled {
            navigate(webview, &target);
            return;
        }

        let Some(mtm) = MainThreadMarker::new() else {
            if let Ok(mut service) = install_state.0.lock() {
                service.adapter_error = Some("WebKit content rules require the main thread".into());
            }
            navigate(webview, &target);
            return;
        };
        let Some(store) = WKContentRuleListStore::defaultStore(mtm) else {
            if let Ok(mut service) = install_state.0.lock() {
                service.adapter_error = Some("WebKit content rule store is unavailable".into());
            }
            navigate(webview, &target);
            return;
        };
        let identifier = NSString::from_str(RULE_LIST_ID);
        let encoded = NSString::from_str(CONTENT_RULES);
        let completion_state = install_state.clone();
        let completion_target = target.clone();
        let completion_webview = webview as *const WKWebView as usize;
        let completion: RcBlock<dyn Fn(*mut WKContentRuleList, *mut NSError)> = RcBlock::new(
            move |rule_list: *mut WKContentRuleList, error: *mut NSError| {
                if error.is_null() && !rule_list.is_null() {
                    controller.addContentRuleList(&*rule_list);
                } else if let Ok(mut service) = completion_state.0.lock() {
                    service.adapter_error = Some(
                        "Native network rules failed; scriptlet filtering remains active".into(),
                    );
                }
                let webview = &*(completion_webview as *const WKWebView);
                navigate(webview, &completion_target);
            },
        );
        store.compileContentRuleListForIdentifier_encodedContentRuleList_completionHandler(
            Some(&identifier),
            Some(&encoded),
            Some(&completion),
        );
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn native_rules_are_valid_and_do_not_block_media_or_player_api() {
        let rules: serde_json::Value = serde_json::from_str(CONTENT_RULES).unwrap();
        assert!(rules.as_array().is_some_and(|rules| !rules.is_empty()));
        assert!(!CONTENT_RULES.contains("googlevideo"));
        assert!(!CONTENT_RULES.contains("youtubei"));
    }
}
