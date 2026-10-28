//! Android-only adapter. No JavaScript/native bridge is exposed to web content.
use jni::{
    objects::{JObject, JString},
    sys::jstring,
    JNIEnv,
};
use pake_blocker_core::{baseline, Blocker};
use std::sync::{Mutex, OnceLock};

// WebView calls interception concurrently on background threads. A single engine
// is process-owned (no raw pointers crossing JNI, including Activity recreation).
static ENGINE: OnceLock<Mutex<Blocker>> = OnceLock::new();

fn respond(mut env: JNIEnv, f: impl FnOnce(&mut JNIEnv) -> Result<String, String>) -> jstring {
    // Never unwind across JNI. Initialization failure is shown by the Android UI.
    match std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| f(&mut env))) {
        Ok(Ok(value)) => match env.new_string(value) {
            Ok(s) => s.into_raw(),
            Err(_) => std::ptr::null_mut(),
        },
        result => {
            let message = match result {
                Ok(Err(e)) => e,
                _ => "Native blocker failed".into(),
            };
            let _ = env.throw_new("java/lang/IllegalStateException", message);
            std::ptr::null_mut()
        }
    }
}

#[no_mangle]
pub extern "system" fn Java_io_github_ltanedo_youtubetv_NativeBlocker_initialize(
    env: JNIEnv,
    _: JObject,
) -> jstring {
    respond(env, |_| {
        if ENGINE.get().is_none() {
            let engine = Blocker::from_bundle(&baseline())?;
            let _ = ENGINE.set(Mutex::new(engine));
        }
        let engine = ENGINE
            .get()
            .unwrap()
            .lock()
            .map_err(|_| "Blocker lock poisoned")?;
        Ok(serde_json::json!({"script": engine.document_script(), "version": engine.version, "fingerprint": engine.fingerprint}).to_string())
    })
}

#[no_mangle]
pub extern "system" fn Java_io_github_ltanedo_youtubetv_NativeBlocker_check(
    env: JNIEnv,
    _: JObject,
    url: JString,
    source: JString,
    kind: JString,
    method: JString,
) -> jstring {
    respond(env, |env| {
        let mut read = |s: &JString| {
            env.get_string(s)
                .map(String::from)
                .map_err(|e| e.to_string())
        };
        let (url, source, kind, method) =
            (read(&url)?, read(&source)?, read(&kind)?, read(&method)?);
        let engine = ENGINE
            .get()
            .ok_or("Blocker not initialized")?
            .lock()
            .map_err(|_| "Blocker lock poisoned")?;
        serde_json::to_string(&engine.decide_method(&url, &source, &kind, &method))
            .map_err(|e| e.to_string())
    })
}
