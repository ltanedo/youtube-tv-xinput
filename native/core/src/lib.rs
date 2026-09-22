use adblock::{Engine, FilterSet, lists::ParseOptions, request::Request, resources::{Resource, PermissionMask}};
use base64::{Engine as _, engine::general_purpose::STANDARD};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::{collections::HashSet, fs, io::Write, path::Path};

pub const ENGINE_VERSION: &str = "adblock-rust 0.13.3";
const LOCAL_RULES: &str = include_str!("youtube-late-ads.txt");
pub const RESOURCE_URL: &str = "https://raw.githubusercontent.com/brave/adblock-rust/master/data/brave/brave-resources.json";
pub const LIST_URLS: &[(&str, &str)] = &[
    ("easylist", "https://easylist.to/easylist/easylist.txt"),
    ("ublock-filters", "https://ublockorigin.github.io/uAssets/filters/filters.min.txt"),
    ("ublock-quick-fixes", "https://raw.githubusercontent.com/uBlockOrigin/uAssets/master/filters/quick-fixes.txt"),
    ("ublock-unbreak", "https://raw.githubusercontent.com/uBlockOrigin/uAssets/master/filters/unbreak.txt"),
];

#[derive(Clone, Serialize, Deserialize)]
pub struct FilterList { pub name: String, pub text: String }
#[derive(Clone, Serialize, Deserialize)]
pub struct Bundle { pub schema: u32, pub version: String, pub lists: Vec<FilterList>, pub resources: Vec<Resource> }

pub fn baseline() -> Bundle {
    Bundle { schema: 1, version: "2026-09-17-uassets-resources-1c0740d".into(),
        lists: vec![
            FilterList { name: "easylist".into(), text: include_str!("../data/easylist.txt").into() },
            FilterList { name: "ublock-filters".into(), text: include_str!("../data/ublock-filters.txt").into() },
            FilterList { name: "ublock-quick-fixes".into(), text: include_str!("../data/ublock-quick-fixes.txt").into() },
            FilterList { name: "ublock-unbreak".into(), text: include_str!("../data/ublock-unbreak.txt").into() },
        ], resources: serde_json::from_str(include_str!("../data/resources.json")).expect("bundled resources JSON") }
}

pub fn is_youtube(url: &str) -> bool {
    url::Url::parse(url).ok().is_some_and(|u| u.scheme() == "https" &&
        matches!(u.host_str(), Some("youtube.com" | "www.youtube.com" | "m.youtube.com" | "music.youtube.com" | "www.youtube-nocookie.com" | "youtube-nocookie.com")))
}

// uAssets conditional sections must not become unconditional rules.
fn condition(expression: &str) -> Result<bool, String> {
    let expression = expression.trim();
    if let Some((a,b)) = expression.split_once("||") { return Ok(condition(a)? || condition(b)?); }
    if let Some((a,b)) = expression.split_once("&&") { return Ok(condition(a)? && condition(b)?); }
    if let Some(rest) = expression.strip_prefix('!') { return Ok(!condition(rest)?); }
    Ok(match expression {
        "env_chromium" | "env_edge" | "ext_ublock" | "ext_ubol" | "true" => expression != "ext_ubol",
        "env_firefox" | "env_mobile" | "env_safari" | "env_mv3" | "cap_html_filtering" | "cap_user_stylesheet" | "cap_ipaddress" | "ext_devbuild" | "false" => false,
        other => return Err(format!("Unknown filter preprocessor condition: {other}")),
    })
}
pub fn preprocess(text: &str) -> Result<String, String> {
    let mut frames: Vec<(bool, bool, bool)> = vec![];
    let mut active = true;
    let mut result = String::new();
    for line in text.lines() {
        let line = line.trim();
        if let Some(expr) = line.strip_prefix("!#if ") {
            let value = condition(expr)?;
            frames.push((active, value, false)); active = active && value;
        } else if line == "!#else" {
            let Some((parent,value,seen)) = frames.last_mut() else { return Err("Unmatched #else".into()) };
            if *seen { return Err("Duplicate #else".into()); } *seen = true; active = *parent && !*value;
        } else if line == "!#endif" {
            active = frames.pop().ok_or("Unmatched #endif")?.0;
        } else if line.starts_with("!#include ") {
            return Err("Unresolved filter include".into());
        } else if active {
            result.push_str(line); result.push('\n');
        }
    }
    if !frames.is_empty() { return Err("Unclosed filter condition".into()); }
    Ok(result)
}

#[derive(Debug, Serialize)]
pub struct Decision {
    pub blocked: bool,
    pub redirect: Option<(String, Vec<u8>)>,
    pub rule_id: Option<String>,
    pub exception: bool,
}
pub struct Blocker { engine: Engine, pub version: String, pub fingerprint: String }
impl Blocker {
    pub fn from_bundle(bundle: &Bundle) -> Result<Self, String> {
        if bundle.schema != 1 || bundle.version.is_empty() || bundle.resources.is_empty() {
            return Err("Invalid bundle schema/resources".into());
        }
        if bundle.lists.len() != LIST_URLS.len() { return Err("Incomplete list bundle".into()); }
        let mut names = HashSet::new();
        let mut set = FilterSet::new(true);
        for list in &bundle.lists {
            if !LIST_URLS.iter().any(|(name,_)| *name == list.name) || !names.insert(&list.name) ||
                list.text.len() < 100 || list.text.len() > 8_000_000 ||
                list.text.trim_start().starts_with('<') { return Err("Invalid filter list".into()); }
            let text = preprocess(&list.text)?;
            let options = ParseOptions { permissions: if list.name.starts_with("ublock") { PermissionMask::from_bits(1) } else { PermissionMask::default() }, ..Default::default() };
            set.add_filter_list(text, options);
        }
        // Apply app compatibility rules to cached bundles too; updating remote lists
        // must not remove a native-app fix or require clearing a user's profile.
        set.add_filter_list(LOCAL_RULES.to_owned(), Default::default());
        for name in ["json-prune-fetch-response.js", "json-prune-xhr-response.js"] {
            if !bundle.resources.iter().any(|resource| resource.name == name) {
                return Err(format!("Missing required late-response scriptlet: {name}"));
            }
        }
        for resource in &bundle.resources {
            if resource.content.len() > 4_000_000 || STANDARD.decode(&resource.content).is_err() {
                return Err("Invalid resource encoding/size".into());
            }
        }
        let mut engine = Engine::new_with_filter_set(set);
        engine.use_resources(bundle.resources.clone());
        let doc = engine.url_cosmetic_resources("https://www.youtube.com/");
        if doc.injected_script.len() < 100 { return Err("Missing YouTube scriptlet resources".into()); }
        let mut digest = Sha256::new();
        digest.update(serde_json::to_vec(bundle).map_err(|e|e.to_string())?);
        digest.update(LOCAL_RULES.as_bytes());
        let fingerprint = format!("{:x}", digest.finalize());
        Ok(Self { engine, version: format!("{}+pake-late-ads-1",bundle.version), fingerprint })
    }
    pub fn decide(&self, url: &str, source: &str, kind: &str) -> Decision {
        self.decide_method(url, source, kind, "GET")
    }
    pub fn decide_method(&self, url: &str, source: &str, kind: &str, method: &str) -> Decision {
        let allow = || Decision { blocked: false, redirect: None, rule_id: None, exception: false };
        if !is_youtube(source) || kind == "document" { return allow(); }
        let Ok(request) = Request::new(url, source, kind, method) else { return allow(); };
        let result = self.engine.check_network_request(&request);
        let blocked = result.should_block();
        let rule_id = result.filter.as_ref().and_then(|r| serde_json::to_vec(r).ok()).map(|bytes| format!("{:x}", Sha256::digest(bytes))[..12].to_string());
        let redirect = if blocked { result.redirect.as_deref().and_then(decode_data_url) } else { None };
        Decision { blocked, redirect, rule_id, exception: result.exception.is_some() }
    }
    pub fn document_script(&self) -> String {
        let mut branches = String::new();
        for host in ["youtube.com","www.youtube.com","m.youtube.com","music.youtube.com","www.youtube-nocookie.com","youtube-nocookie.com"] {
            let doc = self.engine.url_cosmetic_resources(&format!("https://{host}/"));
            let mut styles = doc.hide_selectors.iter().map(|s|format!("{s}{{display:none!important;}}")).collect::<Vec<_>>();
            for action in &doc.procedural_actions {
                if let Ok(action) = serde_json::from_str::<adblock::cosmetic_filter_cache::ProceduralOrActionFilter>(action) {
                    if let Some((selector,style)) = action.as_css() { styles.push(format!("{selector}{{{style}}}")); }
                }
            }
            // Separate rules in the stylesheet so an unsupported selector does not invalidate all rules.
            let css = serde_json::to_string(&styles.join("\n")).unwrap();
            branches.push_str(&format!("if(location.hostname==={}){{\nconst scriptletGlobals=new Map();\n{}\nwindow.__pakeBlockerCss={};\n}}\n", serde_json::to_string(host).unwrap(), doc.injected_script, css));
        }
        format!("(()=>{{if(location.protocol!=='https:')return;let off=false;try{{off=localStorage.getItem('pake-adblock-enabled')==='0'}}catch{{}}if(off)return;{}\n}})();", branches)
    }
}
pub fn decode_data_url(value: &str) -> Option<(String, Vec<u8>)> {
    let (header,body) = value.strip_prefix("data:")?.split_once(',')?;
    let mime = header.strip_suffix(";base64")?;
    if mime.contains(['\r','\n']) { return None; }
    Some((mime.into(), STANDARD.decode(body).ok()?))
}
pub fn atomic_save(path: &Path, bytes: &[u8]) -> Result<(), String> {
    let parent = path.parent().ok_or("Missing cache parent")?;
    fs::create_dir_all(parent).map_err(|e|e.to_string())?;
    let mut file = tempfile::NamedTempFile::new_in(parent).map_err(|e|e.to_string())?;
    file.write_all(bytes).map_err(|e|e.to_string())?;
    file.as_file().sync_all().map_err(|e|e.to_string())?;
    file.persist(path).map_err(|e|e.error.to_string())?;
    Ok(())
}
pub fn load_cached_or_baseline(path: &Path) -> Result<(Blocker, bool), String> {
    if let Ok(metadata) = fs::metadata(path) {
        if metadata.len() < 24_000_000 {
            if let Ok(bytes) = fs::read(path) {
                if let Ok(bundle) = serde_json::from_slice::<Bundle>(&bytes) {
                    if let Ok(engine) = Blocker::from_bundle(&bundle) { return Ok((engine, true)); }
                }
            }
        }
    }
    Blocker::from_bundle(&baseline()).map(|b|(b,false))
}

#[cfg(test)]
mod tests {
    use super::*;
    fn fixture() -> Blocker {
        let mut set = FilterSet::new(true);
        set.add_filter_list(["||ads.test^$script","@@||ads.test/allowed.js$script","||redirect.test^$script,redirect=noop.js","youtube.com##.fixture-ad","youtube.com##+js(set, fixture, true)"].join("\n"), Default::default());
        let mut engine = Engine::new_with_filter_set(set);
        let resources: Vec<Resource> = serde_json::from_str(include_str!("../data/resources.json")).unwrap();
        engine.use_resources(resources);
        Blocker {engine,version:"test".into(),fingerprint:"test".into()}
    }
    #[test] fn decisions_and_exceptions() {
        let b=fixture(); let source="https://www.youtube.com/watch?v=fixture";
        assert!(b.decide("https://ads.test/ad.js",source,"script").blocked);
        assert!(!b.decide("https://ads.test/allowed.js",source,"script").blocked);
        assert!(b.decide("https://ads.test/allowed.js",source,"script").exception);
        assert!(!b.decide("https://video.test/content.mp4",source,"media").blocked);
        assert!(!b.decide("https://ads.test/ad.js","https://accounts.google.com/","script").blocked);
        assert!(!b.decide("https://ads.test/",source,"document").blocked);
        assert!(b.decide("https://redirect.test/a.js",source,"script").redirect.is_some());
    }
    #[test] fn origin_boundary() {
        assert!(!is_youtube("https://youtube.com.evil.test/"));
        assert!(!is_youtube("http://www.youtube.com/"));
        assert!(is_youtube("https://www.youtube.com/watch"));
    }
    #[test] fn conditions() {
        assert_eq!(preprocess("!#if env_firefox\nbad\n!#else\ngood\n!#endif").unwrap(),"good\n");
        assert!(preprocess("!#if unknown\nx\n!#endif").is_err());
    }
    #[test] fn real_baseline_and_cached_recovery() {
        let b=Blocker::from_bundle(&baseline()).unwrap();
        assert!(b.document_script().contains("ytInitialPlayerResponse"));
        assert!(b.document_script().contains("get_watch"));
        assert!(b.version.ends_with("+pake-late-ads-1"));
        let dir=tempfile::tempdir().unwrap(); let file=dir.path().join("bundle.json");
        atomic_save(&file,b"broken").unwrap();
        assert!(!load_cached_or_baseline(&file).unwrap().1);
        let bytes=serde_json::to_vec(&baseline()).unwrap();
        atomic_save(&file,&bytes).unwrap();
        assert!(load_cached_or_baseline(&file).unwrap().1);
        assert!(load_cached_or_baseline(&file).unwrap().0.version.ends_with("+pake-late-ads-1"));
        let before=fs::read(&file).unwrap();
        let mut invalid=baseline(); invalid.resources.clear();
        assert!(Blocker::from_bundle(&invalid).is_err());
        assert_eq!(fs::read(&file).unwrap(),before);
        let mut missing_scriptlet=baseline();
        missing_scriptlet.resources.retain(|r|r.name!="json-prune-fetch-response.js");
        assert!(Blocker::from_bundle(&missing_scriptlet).is_err());
    }
}
