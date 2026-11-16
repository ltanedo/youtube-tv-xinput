// WebKitGTK adapter for the native ad blocker (Linux).
//
// Mirrors native/pake_adblock_macos.rs. WebKit's content-extension JSON format
// is shared by WKContentRuleList and WebKitUserContentFilterStore, so the same
// deliberately narrow network rule list is compiled here and attached to the
// window's WebKitUserContentManager before the first navigation. The shared
// adblock-rust engine still supplies uBO scriptlets, response pruning and
// cosmetic rules at document start (as an initialization script, like macOS).
//
// webkit2gtk-rs 2.0 does not bind WebKitUserContentFilterStore / Filter, so the
// four calls needed go through the generated webkit2gtk-sys FFI. Everything
// that touches WebKit runs on the GTK main thread: with_webview closures and
// the GAsyncReadyCallback both do.
//
// Keep CONTENT_RULES identical to the macOS adapter.
use gtk::prelude::WidgetExt;
use pake_blocker_core::{self as blocker, Blocker, Bundle, FilterList};
use serde::{Deserialize, Serialize};
use std::{
    ffi::CString,
    path::{Path, PathBuf},
    ptr,
    sync::{
        atomic::{AtomicBool, Ordering},
        Arc, Mutex,
    },
    time::{Duration, SystemTime, UNIX_EPOCH},
};
use tauri::{Manager, WebviewWindow};
use webkit2gtk::{
    ffi, gio,
    glib::{self, translate::ToGlibPtr},
    UserContentManager, UserContentManagerExt, WebView, WebViewExt,
};

// WebKit content rules cover request classes that WebKit exposes to applications.
// The shared adblock-rust engine still supplies uBO scriptlets, response pruning,
// and cosmetic rules at document start. Keep this native list deliberately
// narrow: YouTube video media and player API responses must never be blocked.
//
// The last two rules mirror what the Windows engine blocks for the leanback
// (TVHTML5) client, checked against the bundled lists with the page as source:
// the ad-media bootstrap `googlevideo.com/initplayback?source=youtube&…c=TVHTML5&…oad=`
// (uBO filters: `||googlevideo.com/initplayback?source=youtube&*c=TVHTML5&*oad=$xhr,domain=youtube.com`)
// and `youtubei/v1/player/ad_break`. Without them, ads whose metadata survived
// pruning (typically post-rolls) could still load their media.
// Ordinary `videoplayback` and `initplayback` without `oad=` stay allowed.
const CONTENT_RULES: &str = r#"[
  {"trigger":{"url-filter":"^https?://([^/]+\\.)?doubleclick\\.net/","if-domain":["*youtube.com","*youtube-nocookie.com"]},"action":{"type":"block"}},
  {"trigger":{"url-filter":"^https?://([^/]+\\.)?googlesyndication\\.com/","if-domain":["*youtube.com","*youtube-nocookie.com"]},"action":{"type":"block"}},
  {"trigger":{"url-filter":"^https?://([^/]+\\.)?googleadservices\\.com/","if-domain":["*youtube.com","*youtube-nocookie.com"]},"action":{"type":"block"}},
  {"trigger":{"url-filter":"^https?://([^/]+\\.)?youtube\\.com/pagead/","if-domain":["*youtube.com","*youtube-nocookie.com"]},"action":{"type":"block"}},
  {"trigger":{"url-filter":"^https?://([^/]+\\.)?youtube\\.com/api/stats/ads","if-domain":["*youtube.com","*youtube-nocookie.com"]},"action":{"type":"block"}},
  {"trigger":{"url-filter":"^https?://([^/]+\\.)?youtube\\.com/ptracking","if-domain":["*youtube.com","*youtube-nocookie.com"]},"action":{"type":"block"}},
  {"trigger":{"url-filter":"^https?://([^/]+\\.)?youtube\\.com/get_midroll_info","if-domain":["*youtube.com","*youtube-nocookie.com"]},"action":{"type":"block"}},
  {"trigger":{"url-filter":"^https?://([^/]+\\.)?youtube\\.com/youtubei/v1/player/ad_break","if-domain":["*youtube.com","*youtube-nocookie.com"]},"action":{"type":"block"}},
  {"trigger":{"url-filter":"^https?://([^/]+\\.)?googlevideo\\.com/initplayback\\?source=youtube&.*c=TVHTML5&.*oad=","if-domain":["*youtube.com","*youtube-nocookie.com"]},"action":{"type":"block"}}
]"#;
// Bumped whenever CONTENT_RULES change so WebKit never serves a stale compiled list.
const RULE_LIST_ID: &str = "com.pake.youtube.blocker.network.v2";

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

    fn filter_store_dir(&self) -> PathBuf {
        self.cache_dir.join("webkit-filters")
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
        runtime: "WebKitGTK + UserContentFilterStore".into(),
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

fn adapter_error(state: &State, message: &str) {
    if let Ok(mut service) = state.0.lock() {
        service.adapter_error = Some(message.into());
    }
}

/// Runs on the GTK main thread once the rule list is attached or has failed.
type Done = Box<dyn FnOnce(Result<(), String>)>;

struct SaveContext {
    /// Kept alive until WebKit reports back.
    manager: UserContentManager,
    /// WebKit compiles from these bytes asynchronously.
    _source: glib::Bytes,
    done: Done,
}

/// Compiles CONTENT_RULES into `store_dir` and attaches the result to `manager`.
/// Must be called on the GTK main thread; `done` runs there too.
fn attach_rules(manager: &UserContentManager, store_dir: &Path, done: Done) {
    let _ = std::fs::create_dir_all(store_dir);
    let (Ok(store_path), Ok(identifier)) = (
        CString::new(store_dir.to_string_lossy().as_bytes()),
        CString::new(RULE_LIST_ID),
    ) else {
        done(Err("Invalid blocker cache path".into()));
        return;
    };
    let source = glib::Bytes::from_static(CONTENT_RULES.as_bytes());
    let source_ptr: *mut glib::ffi::GBytes = source.to_glib_none().0;
    let context = Box::new(SaveContext {
        manager: manager.clone(),
        _source: source,
        done,
    });
    unsafe {
        let store = ffi::webkit_user_content_filter_store_new(store_path.as_ptr());
        if store.is_null() {
            (context.done)(Err("WebKit content filter store is unavailable".into()));
            return;
        }
        ffi::webkit_user_content_filter_store_save(
            store,
            identifier.as_ptr(),
            source_ptr,
            ptr::null_mut(),
            Some(on_rules_saved),
            Box::into_raw(context) as glib::ffi::gpointer,
        );
        // The pending operation holds its own reference to the store.
        glib::gobject_ffi::g_object_unref(store as *mut glib::gobject_ffi::GObject);
    }
}

unsafe extern "C" fn on_rules_saved(
    source: *mut glib::gobject_ffi::GObject,
    result: *mut gio::ffi::GAsyncResult,
    user_data: glib::ffi::gpointer,
) {
    let SaveContext { manager, _source, done } = *Box::from_raw(user_data as *mut SaveContext);
    let mut error: *mut glib::ffi::GError = ptr::null_mut();
    let filter = ffi::webkit_user_content_filter_store_save_finish(
        source as *mut ffi::WebKitUserContentFilterStore,
        result,
        &mut error,
    );
    if !error.is_null() {
        glib::ffi::g_error_free(error);
    }
    if filter.is_null() {
        done(Err("WebKit could not compile the network blocker".into()));
        return;
    }
    let manager_ptr: *mut ffi::WebKitUserContentManager = manager.to_glib_none().0;
    ffi::webkit_user_content_manager_add_filter(manager_ptr, filter);
    ffi::webkit_user_content_filter_unref(filter);
    done(Ok(()));
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
        .with_webview(|webview| {
            webview.inner().grab_focus();
        })
        .map_err(|error| error.to_string())
}

type Reply = Arc<Mutex<Option<tokio::sync::oneshot::Sender<Result<Status, String>>>>>;

fn reply(pending: &Reply, result: Result<Status, String>) {
    if let Some(sender) = pending.lock().ok().and_then(|mut slot| slot.take()) {
        let _ = sender.send(result);
    }
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
    let pending: Reply = Arc::new(Mutex::new(Some(sender)));
    let operation = pending.clone();
    window
        .with_webview(move |webview| {
            let webview: WebView = webview.inner();
            let Some(manager) = webview.user_content_manager() else {
                reply(&operation, Err("WebKit user content manager is unavailable".into()));
                return;
            };
            manager.remove_all_filters();
            if !enabled {
                reply(&operation, persist_enabled(&state, false));
                return;
            }
            let store_dir = state
                .0
                .lock()
                .map(|service| service.filter_store_dir())
                .unwrap_or_default();
            attach_rules(
                &manager,
                &store_dir,
                Box::new(move |outcome| {
                    reply(&operation, outcome.and_then(|()| persist_enabled(&state, true)));
                }),
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

/// Attaches the network rules (when enabled) and then navigates the window,
/// which starts on about:blank, to `target`.
pub fn install(window: &WebviewWindow, target: String) -> tauri::Result<()> {
    let state = window.state::<State>().inner().clone();
    window.with_webview(move |webview| {
        let webview: WebView = webview.inner();
        let (enabled, store_dir) = match state.0.lock() {
            Ok(service) => (service.enabled, service.filter_store_dir()),
            Err(_) => (true, PathBuf::new()),
        };
        let Some(manager) = webview.user_content_manager() else {
            adapter_error(&state, "WebKit user content manager is unavailable");
            webview.load_uri(&target);
            return;
        };
        manager.remove_all_filters();
        if !enabled {
            webview.load_uri(&target);
            return;
        }
        attach_rules(
            &manager,
            &store_dir,
            Box::new(move |outcome| {
                if outcome.is_err() {
                    adapter_error(
                        &state,
                        "Native network rules failed; scriptlet filtering remains active",
                    );
                }
                webview.load_uri(&target);
            }),
        );
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn native_rules_are_valid_and_do_not_block_media_or_player_api() {
        let rules: serde_json::Value = serde_json::from_str(CONTENT_RULES).unwrap();
        let rules = rules.as_array().expect("rule array");
        assert!(!rules.is_empty());
        for rule in rules {
            let filter = rule["trigger"]["url-filter"].as_str().expect("url-filter");
            assert_eq!(rule["action"]["type"], "block");
            assert!(rule["trigger"]["if-domain"].is_array(), "rules are scoped to YouTube pages");
            // Media is only ever matched together with the ad marker; the player
            // API is only matched on its ad_break endpoint.
            if filter.contains("googlevideo") {
                assert!(filter.contains("initplayback") && filter.contains("oad="), "{filter}");
            }
            if filter.contains("youtubei") {
                assert!(filter.contains("youtubei/v1/player/ad_break"), "{filter}");
            }
            assert!(!filter.contains("videoplayback"), "{filter}");
        }
    }

    #[test]
    fn rule_list_matches_the_macos_adapter() {
        // The two WebKit adapters must compile the same list; a drift here means
        // one platform silently lost (or gained) a network rule.
        let macos = include_str!("../../../../native/pake_adblock_macos.rs");
        assert!(macos.contains(CONTENT_RULES), "CONTENT_RULES differ from pake_adblock_macos.rs");
        assert!(macos.contains(RULE_LIST_ID), "RULE_LIST_ID differs from pake_adblock_macos.rs");
    }
}
