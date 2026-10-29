package io.github.ltanedo.youtubetv

import android.annotation.SuppressLint
import android.app.Activity
import android.app.AlertDialog
import android.graphics.Color
import android.hardware.input.InputManager
import android.os.Bundle
import android.os.Handler
import android.os.Looper
import android.view.InputDevice
import android.view.KeyEvent
import android.view.MotionEvent
import android.view.View
import android.view.WindowManager
import android.webkit.CookieManager
import android.webkit.WebChromeClient
import android.webkit.WebSettings
import android.webkit.WebView
import android.widget.FrameLayout
import android.widget.TextView
import android.widget.Toast
import androidx.webkit.ScriptHandler
import androidx.webkit.WebViewCompat
import androidx.webkit.WebViewFeature
import org.json.JSONObject
import java.util.concurrent.Executors

class MainActivity : Activity(), InputManager.InputDeviceListener {
    lateinit var web: WebView
        private set
    lateinit var filtering: FilteringClient
        private set
    @Volatile var blockingEnabled = true
        private set
    var ready = false
        private set
    var fillScreen = false
        private set
    var backgroundPlay = true
        private set
    var touchLocked = false
        private set
    private var foreground = false
    private var serviceRequested = false
    private val playbackPoll = object : Runnable {
        override fun run() {
            if (ready && backgroundPlay && FilteringClient.isYouTube(android.net.Uri.parse(web.url ?: ""))) {
                web.evaluateJavascript("Array.from(document.querySelectorAll('video,audio')).some(v=>!v.paused&&!v.ended&&v.readyState>=2)") { value ->
                    if (!isDestroyed && backgroundPlay) {
                        if (value == "true" && foreground && !serviceRequested) {
                            PlaybackService.owner = java.lang.ref.WeakReference(this@MainActivity)
                            try {
                                startForegroundService(android.content.Intent(this@MainActivity, PlaybackService::class.java))
                                serviceRequested = true
                            } catch (_: IllegalStateException) { /* OS rejected a late background start. */ }
                        } else if (value != "true") stopPlaybackService()
                    }
                }
            } else stopPlaybackService()
            handler.postDelayed(this, 500)
        }
    }
    private val handler = Handler(Looper.getMainLooper())
    private val loader = Executors.newSingleThreadExecutor()
    private var scriptHandler: ScriptHandler? = null
    private var blockerScript = ""
    private var version = ""
    private var fingerprint = ""
    private var settingsDialog: AlertDialog? = null
    private var backHeld = false
    private var axisKey: Int? = null
    private lateinit var touchNavigation: TouchNavigation
    private var touchCaptured = false
    private val repeatAxis = object : Runnable {
        override fun run() {
            axisKey?.let { sendKey(it); handler.postDelayed(this, 110) }
        }
    }
    private val longBack = Runnable { backHeld = true; showSettings() }

    @SuppressLint("SetJavaScriptEnabled")
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        getSystemService(InputManager::class.java).registerInputDeviceListener(this, handler)
        window.addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON)
        window.decorView.systemUiVisibility = View.SYSTEM_UI_FLAG_FULLSCREEN or View.SYSTEM_UI_FLAG_HIDE_NAVIGATION or
            View.SYSTEM_UI_FLAG_IMMERSIVE_STICKY or View.SYSTEM_UI_FLAG_LAYOUT_FULLSCREEN or View.SYSTEM_UI_FLAG_LAYOUT_HIDE_NAVIGATION
        blockingEnabled = getPreferences(MODE_PRIVATE).getBoolean("blocking", true)
        fillScreen = getPreferences(MODE_PRIVATE).getBoolean("fillScreen", false)
        backgroundPlay = getPreferences(MODE_PRIVATE).getBoolean("backgroundPlay", true)
        val root = FrameLayout(this)
        root.setBackgroundColor(Color.BLACK)
        val loading = TextView(this).apply {
            text = "Starting YouTubeTV…"
            setTextColor(Color.WHITE)
            gravity = android.view.Gravity.CENTER
        }
        root.addView(loading, FrameLayout.LayoutParams(-1, -1))
        setContentView(root)
        web = object : WebView(this) {
            override fun onWindowVisibilityChanged(visibility: Int) {
                // Keep Chromium's media renderer alive while the activity is hidden.
                super.onWindowVisibilityChanged(if (backgroundPlay && !isFinishing) View.VISIBLE else visibility)
            }
        }.apply {
            setBackgroundColor(Color.BLACK)
            settings.javaScriptEnabled = true
            settings.domStorageEnabled = true
            settings.mediaPlaybackRequiresUserGesture = false
            settings.userAgentString = CONSOLE_UA
            settings.allowFileAccess = false
            settings.allowContentAccess = false
            settings.mixedContentMode = WebSettings.MIXED_CONTENT_NEVER_ALLOW
            settings.setSupportMultipleWindows(false)
            webChromeClient = WebChromeClient()
        }
        touchNavigation = TouchNavigation(this, { if (!touchLocked) sendKey(it) }, ::showSettings)
        web.setOnTouchListener { _, event ->
            if (event.actionMasked == MotionEvent.ACTION_DOWN) {
                touchCaptured = ready && event.isFromSource(InputDevice.SOURCE_TOUCHSCREEN) &&
                    FilteringClient.isYouTube(android.net.Uri.parse(web.url ?: ""))
            }
            if (touchCaptured) {
                touchNavigation.touch(event)
                if (event.actionMasked == MotionEvent.ACTION_UP || event.actionMasked == MotionEvent.ACTION_CANCEL) touchCaptured = false
                true
            } else false // Preserve native touch on Google sign-in/consent pages and mouse input.
        }
        WebView.setWebContentsDebuggingEnabled(BuildConfig.DEBUG)
        CookieManager.getInstance().setAcceptCookie(true)
        CookieManager.getInstance().setAcceptThirdPartyCookies(web, false)
        filtering = FilteringClient { blockingEnabled }
        web.webViewClient = filtering
        if (!WebViewFeature.isFeatureSupported(WebViewFeature.DOCUMENT_START_SCRIPT)) {
            loading.text = "Update Android System WebView to use YouTubeTV.\nThis app requires document-start script support."
            return
        }
        loader.execute {
            try {
                val info = JSONObject(NativeBlocker.initialize())
                blockerScript = info.getString("script")
                version = info.getString("version")
                fingerprint = info.getString("fingerprint")
                runOnUiThread {
                    if (isDestroyed || isFinishing) return@runOnUiThread
                    installScripts()
                    root.removeView(loading)
                    root.addView(web, FrameLayout.LayoutParams(-1, -1))
                    web.requestFocus()
                    ready = true
                    handler.post(playbackPoll)
                    web.loadUrl(START_URL)
                    Toast.makeText(this, "Swipe to navigate • Tap to select • Double-tap to go back • Hold for settings", Toast.LENGTH_LONG).show()
                }
            } catch (_: Exception) {
                runOnUiThread { loading.text = "Could not initialize the ad blocker.\nClose and reopen YouTubeTV to retry." }
            }
        }
    }

    private fun asset(name: String) = assets.open(name).bufferedReader().use { it.readText() }

    private fun installScripts() {
        check(WebViewFeature.isFeatureSupported(WebViewFeature.DOCUMENT_START_SCRIPT))
        scriptHandler?.remove()
        val css = JSONObject.quote(asset("yttv.css"))
        val script = buildString {
            append("if(window===window.top){\n")
            append(asset("tv-navigator.js"))
            // Native preference is authoritative, including when enabling after
            // a previous document persisted the disabled localStorage flag.
            append("\ntry{localStorage.setItem('pake-adblock-enabled','${if (blockingEnabled) "1" else "0"}')}catch(_){}\n")
            if (blockingEnabled) append(blockerScript)
            append("\n")
            append(asset("tv-player.js"))
            append("\n")
            append(asset("android-player.js"))
            append("\nwindow.__yttvPreferences($fillScreen,$backgroundPlay);\n")
            append("""
                (()=>{
                  const mount=()=>{
                    const style=document.createElement('style');
                    style.textContent=$css+'\n'+(window.__pakeBlockerCss||'');
                    (document.head||document.documentElement).appendChild(style);
                  };
                  if(document.documentElement)mount();
                  else document.addEventListener('DOMContentLoaded',mount,{once:true});
                })();
            """.trimIndent())
            append("\n}")
        }
        scriptHandler = WebViewCompat.addDocumentStartJavaScript(web, script, YOUTUBE_ORIGINS)
    }

    fun setBlocking(enabled: Boolean) {
        blockingEnabled = enabled
        getPreferences(MODE_PRIVATE).edit().putBoolean("blocking", enabled).apply()
        installScripts()
        web.reload()
    }

    fun setFillScreen(enabled: Boolean) {
        fillScreen = enabled
        getPreferences(MODE_PRIVATE).edit().putBoolean("fillScreen", enabled).apply()
        applyPlaybackPreferences()
    }

    fun setBackgroundPlay(enabled: Boolean) {
        backgroundPlay = enabled
        getPreferences(MODE_PRIVATE).edit().putBoolean("backgroundPlay", enabled).apply()
        applyPlaybackPreferences()
        if (!enabled) {
            stopPlaybackService()
            if (!foreground) { pausePlayback(); web.onPause() }
        } else web.onResume()
    }

    fun setTouchLocked(locked: Boolean) {
        touchLocked = locked
        touchNavigation.cancel()
        Toast.makeText(this, if (locked) "Touch locked. Hold to open settings and unlock." else "Touch unlocked", Toast.LENGTH_SHORT).show()
    }

    private fun applyPlaybackPreferences() {
        if (!ready) return
        installScripts()
        if (FilteringClient.isYouTube(android.net.Uri.parse(web.url ?: "")))
            web.evaluateJavascript("window.__yttvPreferences?.($fillScreen,$backgroundPlay)", null)
    }

    fun pausePlayback() {
        if (ready) web.evaluateJavascript("document.querySelectorAll('video,audio').forEach(v=>v.pause())", null)
        stopPlaybackService()
    }

    private fun stopPlaybackService() {
        if (serviceRequested || PlaybackService.active) stopService(android.content.Intent(this, PlaybackService::class.java))
        serviceRequested = false
    }

    private fun showSettings() {
        if (!ready || settingsDialog?.isShowing == true) return
        stopAxis()
        val runtime = WebViewCompat.getCurrentWebViewPackage(this)?.versionName ?: "unknown"
        settingsDialog = AlertDialog.Builder(this)
            .setTitle("YouTubeTV")
            .setItems(arrayOf(
                "Ad blocking: ${if (blockingEnabled) "on" else "off"} — toggle",
                "Reload YouTube", "Return to home", "Diagnostics", "Exit",
                "Zoom: ${if (fillScreen) "fill screen (crop)" else "fit entire video"} — toggle",
                "Background play: ${if (backgroundPlay) "on" else "off"} — toggle",
                if (touchLocked) "Unlock touch controls" else "Lock touch controls"
            )) { _, index ->
                when (index) {
                    0 -> setBlocking(!blockingEnabled)
                    1 -> web.reload()
                    2 -> web.loadUrl(START_URL)
                    3 -> AlertDialog.Builder(this).setTitle("Diagnostics").setMessage(
                        "Blocked requests: ${filtering.blocked.get()}\nFilter errors: ${filtering.failures.get()}\n\n" +
                        "$version\nFingerprint: ${fingerprint.take(16)}\nWebView: $runtime\n\n" +
                        "Bundled filters; updates ship with the app.\nTouch: swipe to navigate, tap to select, double-tap back, hold for settings.\nRemote: hold Back or press Menu/F1 for settings."
                    ).setPositiveButton("OK", null).show()
                    4 -> finish()
                    5 -> setFillScreen(!fillScreen)
                    6 -> setBackgroundPlay(!backgroundPlay)
                    7 -> setTouchLocked(!touchLocked)
                }
            }.setOnDismissListener { web.requestFocus() }.show()
    }

    override fun dispatchKeyEvent(event: KeyEvent): Boolean {
        if (!ready || settingsDialog?.isShowing == true) return super.dispatchKeyEvent(event)
        if (event.action == KeyEvent.ACTION_DOWN) touchNavigation.cancel()
        if (event.keyCode == KeyEvent.KEYCODE_MENU || event.keyCode == KeyEvent.KEYCODE_F1) {
            if (event.action == KeyEvent.ACTION_DOWN && event.repeatCount == 0) showSettings()
            return true
        }
        if (event.keyCode == KeyEvent.KEYCODE_BACK) {
            if (event.action == KeyEvent.ACTION_DOWN && event.repeatCount == 0) {
                backHeld = false
                handler.postDelayed(longBack, 700)
            } else if (event.action == KeyEvent.ACTION_UP) {
                handler.removeCallbacks(longBack)
                if (!backHeld && !event.isCanceled) {
                    if (FilteringClient.isYouTube(android.net.Uri.parse(web.url ?: ""))) sendKey(KeyEvent.KEYCODE_ESCAPE)
                    else if (web.canGoBack()) web.goBack() else showSettings()
                }
            }
            return true
        }
        val mapped = mapKey(event.keyCode) ?: return super.dispatchKeyEvent(event)
        // Allow native WebView navigation on consent/sign-in pages.
        if (!FilteringClient.isYouTube(android.net.Uri.parse(web.url ?: ""))) return super.dispatchKeyEvent(event)
        if (event.action == KeyEvent.ACTION_DOWN && (event.repeatCount == 0 || mapped in 19..22)) sendKey(mapped)
        return true
    }

    private fun mapKey(code: Int): Int? = when (code) {
        KeyEvent.KEYCODE_DPAD_UP, KeyEvent.KEYCODE_DPAD_DOWN, KeyEvent.KEYCODE_DPAD_LEFT,
        KeyEvent.KEYCODE_DPAD_RIGHT, KeyEvent.KEYCODE_ENTER, KeyEvent.KEYCODE_ESCAPE,
        KeyEvent.KEYCODE_SPACE, KeyEvent.KEYCODE_PAGE_UP, KeyEvent.KEYCODE_PAGE_DOWN -> code
        KeyEvent.KEYCODE_DPAD_CENTER, KeyEvent.KEYCODE_BUTTON_A, KeyEvent.KEYCODE_BUTTON_START,
        KeyEvent.KEYCODE_BUTTON_THUMBL -> KeyEvent.KEYCODE_ENTER
        KeyEvent.KEYCODE_BUTTON_B, KeyEvent.KEYCODE_BUTTON_SELECT, KeyEvent.KEYCODE_BUTTON_THUMBR -> KeyEvent.KEYCODE_ESCAPE
        KeyEvent.KEYCODE_BUTTON_X, KeyEvent.KEYCODE_MEDIA_PLAY_PAUSE -> KeyEvent.KEYCODE_SPACE
        KeyEvent.KEYCODE_BUTTON_Y, KeyEvent.KEYCODE_SEARCH -> KeyEvent.KEYCODE_SLASH
        KeyEvent.KEYCODE_BUTTON_L1 -> KeyEvent.KEYCODE_PAGE_UP
        KeyEvent.KEYCODE_BUTTON_R1 -> KeyEvent.KEYCODE_PAGE_DOWN
        KeyEvent.KEYCODE_BUTTON_L2, KeyEvent.KEYCODE_BUTTON_R2 -> code
        else -> null
    }

    private fun sendKey(code: Int) {
        if (!FilteringClient.isYouTube(android.net.Uri.parse(web.url ?: ""))) return
        if (code == KeyEvent.KEYCODE_BUTTON_L2 || code == KeyEvent.KEYCODE_BUTTON_R2) {
            if (code == KeyEvent.KEYCODE_BUTTON_R2) setFillScreen(!fillScreen)
            val name = if (code == KeyEvent.KEYCODE_BUTTON_L2) "captions" else "aspect"
            web.evaluateJavascript("window.dispatchEvent(new Event('pake:$name-toggle'))", null)
            return
        }
        val key = when (code) {
            KeyEvent.KEYCODE_DPAD_UP -> Triple("ArrowUp", "ArrowUp", 38)
            KeyEvent.KEYCODE_DPAD_DOWN -> Triple("ArrowDown", "ArrowDown", 40)
            KeyEvent.KEYCODE_DPAD_LEFT -> Triple("ArrowLeft", "ArrowLeft", 37)
            KeyEvent.KEYCODE_DPAD_RIGHT -> Triple("ArrowRight", "ArrowRight", 39)
            KeyEvent.KEYCODE_ENTER -> Triple("Enter", "Enter", 13)
            KeyEvent.KEYCODE_ESCAPE -> Triple("Escape", "Escape", 27)
            KeyEvent.KEYCODE_SPACE -> Triple(" ", "Space", 32)
            KeyEvent.KEYCODE_SLASH -> Triple("/", "Slash", 191)
            KeyEvent.KEYCODE_PAGE_UP -> Triple("PageUp", "PageUp", 33)
            KeyEvent.KEYCODE_PAGE_DOWN -> Triple("PageDown", "PageDown", 34)
            else -> return
        }
        web.evaluateJavascript("""
            (()=>{const target=document.activeElement||document.body;
            for(const type of ['keydown','keyup'])target.dispatchEvent(new KeyboardEvent(type,{
            key:${JSONObject.quote(key.first)},code:${JSONObject.quote(key.second)},keyCode:${key.third},which:${key.third},bubbles:true,cancelable:true}));})();
        """.trimIndent(), null)
    }

    override fun onGenericMotionEvent(event: MotionEvent): Boolean {
        if (ready && settingsDialog?.isShowing != true && event.isFromSource(InputDevice.SOURCE_JOYSTICK)) {
            touchNavigation.cancel()
            val x = event.getAxisValue(MotionEvent.AXIS_X) + event.getAxisValue(MotionEvent.AXIS_HAT_X)
            val y = event.getAxisValue(MotionEvent.AXIS_Y) + event.getAxisValue(MotionEvent.AXIS_HAT_Y)
            val key = when {
                x > .5f -> KeyEvent.KEYCODE_DPAD_RIGHT
                x < -.5f -> KeyEvent.KEYCODE_DPAD_LEFT
                y > .5f -> KeyEvent.KEYCODE_DPAD_DOWN
                y < -.5f -> KeyEvent.KEYCODE_DPAD_UP
                else -> null
            }
            if (key != axisKey) {
                stopAxis()
                axisKey = key
                key?.let { sendKey(it); handler.postDelayed(repeatAxis, 350) }
            }
            return true
        }
        return super.onGenericMotionEvent(event)
    }

    private fun stopAxis() { axisKey = null; handler.removeCallbacks(repeatAxis) }
    override fun onInputDeviceAdded(deviceId: Int) = Unit
    override fun onInputDeviceChanged(deviceId: Int) { stopAxis() }
    override fun onInputDeviceRemoved(deviceId: Int) { stopAxis() }

    override fun onWindowFocusChanged(hasFocus: Boolean) {
        super.onWindowFocusChanged(hasFocus)
        if (!hasFocus) { stopAxis(); handler.removeCallbacks(longBack); if (::touchNavigation.isInitialized) touchNavigation.cancel() }
    }

    override fun onPause() {
        stopAxis()
        touchNavigation.cancel()
        handler.removeCallbacks(longBack)
        if (!backgroundPlay || isFinishing) { pausePlayback(); web.onPause() }
        foreground = false
        CookieManager.getInstance().flush()
        super.onPause()
    }
    override fun onResume() { super.onResume(); foreground = true; if (::web.isInitialized) web.onResume() }
    override fun onDestroy() {
        stopPlaybackService()
        PlaybackService.owner = null
        handler.removeCallbacksAndMessages(null)
        touchNavigation.cancel()
        loader.shutdown()
        getSystemService(InputManager::class.java).unregisterInputDeviceListener(this)
        settingsDialog?.dismiss()
        if (WebViewFeature.isFeatureSupported(WebViewFeature.DOCUMENT_START_SCRIPT)) scriptHandler?.remove()
        web.destroy()
        super.onDestroy()
    }

    companion object {
        const val START_URL = "https://www.youtube.com/tv"
        const val CONSOLE_UA = "Mozilla/5.0 (PS4; Leanback Shell) Gecko/20100101 Firefox/65.0 LeanbackShell/01.00.01.75 Sony PS4/ (PS4, , no, CH)"
        val YOUTUBE_ORIGINS = setOf("https://youtube.com", "https://www.youtube.com", "https://m.youtube.com",
            "https://music.youtube.com", "https://youtube-nocookie.com", "https://www.youtube-nocookie.com")
    }
}
