package io.github.ltanedo.youtubetv

import android.net.Uri
import android.os.SystemClock
import android.view.KeyEvent
import android.webkit.WebResourceRequest
import android.webkit.WebResourceResponse
import androidx.test.core.app.ActivityScenario
import androidx.test.ext.junit.runners.AndroidJUnit4
import org.json.JSONObject
import org.junit.Assert.*
import org.junit.Test
import org.junit.runner.RunWith
import java.io.ByteArrayInputStream
import java.util.concurrent.CountDownLatch
import java.util.concurrent.TimeUnit

@RunWith(AndroidJUnit4::class)
class PortTest {
    private fun decision(url: String, source: String = MainActivity.START_URL, kind: String = "xmlhttprequest") =
        JSONObject(NativeBlocker.check(url, source, kind, "GET"))

    @Test fun nativeEngineBlocksAdsButPreservesMediaAndLogin() {
        val metadata = JSONObject(NativeBlocker.initialize())
        assertTrue(metadata.getString("script").contains("playerAds"))
        assertEquals(64, metadata.getString("fingerprint").length)
        assertTrue(decision("https://www.youtube.com/pagead/interaction/").getBoolean("blocked"))
        assertTrue(decision("https://rr1---sn-test.googlevideo.com/initplayback?source=youtube&c=TVHTML5&oad=1").getBoolean("blocked"))
        assertFalse(decision("https://rr1---sn-test.googlevideo.com/videoplayback?id=content", kind = "media").getBoolean("blocked"))
        assertFalse(decision("https://rr1---sn-test.googlevideo.com/initplayback?source=youtube&c=TVHTML5").getBoolean("blocked"))
        assertFalse(decision("https://www.youtube.com/pagead/interaction/", "https://accounts.google.com/").getBoolean("blocked"))
        assertFalse(decision("https://www.youtube.com/pagead/interaction/", kind = "document").getBoolean("blocked"))
    }

    @Test fun navigationPolicyRestrictsTopLevelOrigins() {
        for (url in listOf(MainActivity.START_URL, "https://accounts.google.com/", "https://consent.youtube.com/")) {
            assertTrue(url, FilteringClient.allowedNavigation(Uri.parse(url)))
        }
        for (url in listOf("http://www.youtube.com/tv", "https://youtube.com.evil.test/", "file:///etc/passwd", "intent://test", "https://example.org/")) {
            assertFalse(url, FilteringClient.allowedNavigation(Uri.parse(url)))
        }
    }

    // These fixtures run in the real Android WebView at a permitted origin.
    // No real YouTube responses, accounts, or ad availability affect assertions.
    private val fixture = """
        <!doctype html><html><head><script>
        window.earlyUA=navigator.userAgent;
        window.keys=[];document.addEventListener('keydown',e=>keys.push(e.keyCode));
        window.clicks=0;document.addEventListener('click',()=>clicks++);
        window.captionEvents=0;window.addEventListener('pake:captions-toggle',()=>captionEvents++);
        window.aspectEvents=0;window.addEventListener('pake:aspect-toggle',()=>aspectEvents++);
        </script></head><body>Android port fixture<script>
        Promise.all([
          fetch('/youtubei/v1/player?fixture=1').then(r=>r.json()),
          new Promise(resolve=>{let x=new XMLHttpRequest();x.open('GET','/youtubei/v1/next?fixture=1');
            x.onload=()=>resolve(JSON.parse(x.responseText));x.send()}),
          fetch('/pagead/interaction/').then(r=>r.status)
        ]).then(([fetchResult,xhrResult,adStatus])=>{window.results={fetchResult,xhrResult,adStatus}});
        </script></body></html>
    """.trimIndent()
    private val response = """{"playerAds":[{"ad":true}],"adPlacements":[{}],"adSlots":[{}],"videoDetails":{"videoId":"keep-me"},"streamingData":{"formats":[{"url":"keep-media"}]}}"""

    private fun useFixture(activity: MainActivity) {
        activity.web.webViewClient = object : FilteringClient({ activity.blockingEnabled }) {
            override fun shouldInterceptRequest(view: android.webkit.WebView?, request: WebResourceRequest): WebResourceResponse {
                super.shouldInterceptRequest(view, request)?.let { return it }
                val isHtml = request.url.path == "/tv"
                return WebResourceResponse(if (isHtml) "text/html" else "application/json", "utf-8",
                    ByteArrayInputStream((if (isHtml) fixture else response).toByteArray()))
            }
        }
        activity.web.loadUrl(MainActivity.START_URL)
    }

    private fun awaitReady(scenario: ActivityScenario<MainActivity>) {
        val deadline = SystemClock.elapsedRealtime() + 30000
        while (SystemClock.elapsedRealtime() < deadline) {
            var ready = false
            scenario.onActivity { ready = it.ready && it.web.hasWindowFocus() &&
                it.resources.configuration.orientation == android.content.res.Configuration.ORIENTATION_LANDSCAPE }
            if (ready) return
            SystemClock.sleep(100)
        }
        fail("Activity did not initialize the native blocker and document-start scripts")
    }

    private fun evaluate(scenario: ActivityScenario<MainActivity>, script: String): String {
        val latch = CountDownLatch(1)
        var value = ""
        scenario.onActivity { it.web.evaluateJavascript(script) { result -> value = result; latch.countDown() } }
        assertTrue("JavaScript evaluation timed out", latch.await(10, TimeUnit.SECONDS))
        return value
    }

    private fun awaitJs(scenario: ActivityScenario<MainActivity>, expression: String): String {
        val deadline = SystemClock.elapsedRealtime() + 15000
        while (SystemClock.elapsedRealtime() < deadline) {
            val value = evaluate(scenario, expression)
            if (value != "null" && value != "false") return value
            SystemClock.sleep(100)
        }
        error("Timed out waiting for $expression")
    }

    @Test fun documentStartPruningNetworkBlockingAndToggleWorkTogether() {
        ActivityScenario.launch(MainActivity::class.java).use { scenario ->
            awaitReady(scenario)
            scenario.onActivity { it.setBlocking(true); useFixture(it) }
            val result = JSONObject(awaitJs(scenario, "window.results || null"))
            assertEquals(403, result.getInt("adStatus"))
            for (name in listOf("fetchResult", "xhrResult")) {
                val body = result.getJSONObject(name)
                for (field in listOf("playerAds", "adPlacements", "adSlots")) assertFalse("$name.$field", body.has(field))
                assertEquals("keep-me", body.getJSONObject("videoDetails").getString("videoId"))
                assertEquals("keep-media", body.getJSONObject("streamingData").getJSONArray("formats").getJSONObject(0).getString("url"))
            }
            assertEquals(MainActivity.CONSOLE_UA, org.json.JSONTokener(evaluate(scenario, "earlyUA")).nextValue())
            assertEquals("true", evaluate(scenario, "!!window.__pakeBlockerCss"))
            scenario.onActivity { it.setBlocking(false) }
            // Wait for a new document, rather than reading the previous result.
            awaitJs(scenario, "localStorage.getItem('pake-adblock-enabled')==='0' && window.results || null")
            val disabled = JSONObject(evaluate(scenario, "results"))
            assertEquals(200, disabled.getInt("adStatus"))
            assertTrue(disabled.getJSONObject("fetchResult").has("playerAds"))
            scenario.onActivity { it.setBlocking(true) }
            awaitJs(scenario, "localStorage.getItem('pake-adblock-enabled')==='1' && window.results && results.adStatus===403")
        }
    }

    @Test fun remoteAndControllerInputReachThePageOnce() {
        ActivityScenario.launch(MainActivity::class.java).use { scenario ->
            awaitReady(scenario)
            scenario.onActivity { useFixture(it) }
            awaitJs(scenario, "window.results || null")
            scenario.onActivity { activity ->
                for (key in listOf(KeyEvent.KEYCODE_DPAD_RIGHT, KeyEvent.KEYCODE_DPAD_CENTER,
                    KeyEvent.KEYCODE_BUTTON_B, KeyEvent.KEYCODE_BUTTON_X, KeyEvent.KEYCODE_BUTTON_L2,
                    KeyEvent.KEYCODE_BUTTON_R2, KeyEvent.KEYCODE_BUTTON_Y, KeyEvent.KEYCODE_BUTTON_L1, KeyEvent.KEYCODE_BUTTON_R1)) {
                    activity.dispatchKeyEvent(KeyEvent(KeyEvent.ACTION_DOWN, key))
                    activity.dispatchKeyEvent(KeyEvent(KeyEvent.ACTION_UP, key))
                }
            }
            awaitJs(scenario, "keys.length===7 && captionEvents===1 && aspectEvents===1")
            assertEquals("[39,13,27,32,191,33,34]", evaluate(scenario, "keys"))
        }
    }

    @Test fun stickRepeatsStopWhenControllerDisconnects() {
        ActivityScenario.launch(MainActivity::class.java).use { scenario ->
            awaitReady(scenario)
            scenario.onActivity { useFixture(it) }
            awaitJs(scenario, "window.results || null")
            scenario.onActivity { activity ->
                val now = SystemClock.uptimeMillis()
                val coordinates = android.view.MotionEvent.PointerCoords().apply {
                    setAxisValue(android.view.MotionEvent.AXIS_X, 1f)
                }
                val pointer = android.view.MotionEvent.PointerProperties().apply { id = 0 }
                val event = android.view.MotionEvent.obtain(now, now, android.view.MotionEvent.ACTION_MOVE, 1,
                    arrayOf(pointer), arrayOf(coordinates), 0, 0, 1f, 1f, 0, 0,
                    android.view.InputDevice.SOURCE_JOYSTICK, 0)
                activity.onGenericMotionEvent(event)
                event.recycle()
            }
            awaitJs(scenario, "keys.length>=2")
            scenario.onActivity { it.onInputDeviceRemoved(0) }
            val count = evaluate(scenario, "keys.length")
            SystemClock.sleep(500)
            assertEquals(count, evaluate(scenario, "keys.length"))
        }
    }

    private fun touch(scenario: ActivityScenario<MainActivity>, action: Int, x: Float, y: Float, down: Long) {
        scenario.onActivity {
            val event = android.view.MotionEvent.obtain(down, SystemClock.uptimeMillis(), action, x, y, 0)
            event.source = android.view.InputDevice.SOURCE_TOUCHSCREEN
            it.web.dispatchTouchEvent(event)
            event.recycle()
        }
    }

    @Test fun touchscreenDirectionsTapDoubleTapAndRemoteCoexistWithoutClicks() {
        ActivityScenario.launch(MainActivity::class.java).use { scenario ->
            awaitReady(scenario)
            scenario.onActivity { useFixture(it) }
            awaitJs(scenario, "window.results || null")
            // Physical pixels deliberately exceed 48dp even on high-density displays.
            for ((dx, dy) in listOf(300f to 0f, -300f to 0f, 0f to -300f, 0f to 300f)) {
                val down = SystemClock.uptimeMillis()
                touch(scenario, 0, 500f, 400f, down)
                touch(scenario, 2, 500f + dx, 400f + dy, down)
                touch(scenario, 1, 500f + dx, 400f + dy, down)
            }
            assertEquals("[39,37,38,40]", evaluate(scenario, "keys"))
            var down = SystemClock.uptimeMillis()
            touch(scenario, 0, 500f, 400f, down)
            touch(scenario, 1, 500f, 400f, down)
            awaitJs(scenario, "keys.length===5")
            // A double tap produces Back only, with no extra Select or DOM clicks.
            SystemClock.sleep(350)
            down = SystemClock.uptimeMillis()
            touch(scenario, 0, 500f, 400f, down)
            touch(scenario, 1, 500f, 400f, down)
            SystemClock.sleep(80)
            down = SystemClock.uptimeMillis()
            touch(scenario, 0, 500f, 400f, down)
            touch(scenario, 1, 500f, 400f, down)
            SystemClock.sleep(350)
            scenario.onActivity {
                for (key in listOf(KeyEvent.KEYCODE_DPAD_LEFT, KeyEvent.KEYCODE_DPAD_CENTER, KeyEvent.KEYCODE_BACK)) {
                    it.dispatchKeyEvent(KeyEvent(KeyEvent.ACTION_DOWN, key))
                    it.dispatchKeyEvent(KeyEvent(KeyEvent.ACTION_UP, key))
                }
            }
            awaitJs(scenario, "keys.length===9")
            assertEquals("[39,37,38,40,13,27,37,13,27]", evaluate(scenario, "keys"))
            assertEquals("0", evaluate(scenario, "clicks"))
            // Switching to a remote cancels an unconfirmed touch selection.
            down = SystemClock.uptimeMillis()
            touch(scenario, 0, 500f, 400f, down)
            touch(scenario, 1, 500f, 400f, down)
            scenario.onActivity {
                it.dispatchKeyEvent(KeyEvent(KeyEvent.ACTION_DOWN, KeyEvent.KEYCODE_DPAD_UP))
                it.dispatchKeyEvent(KeyEvent(KeyEvent.ACTION_UP, KeyEvent.KEYCODE_DPAD_UP))
            }
            SystemClock.sleep(350)
            assertEquals("[39,37,38,40,13,27,37,13,27,38]", evaluate(scenario, "keys"))
        }
    }

    @Test fun cancelledTouchDoesNotNavigateAndHoldOpensSettings() {
        ActivityScenario.launch(MainActivity::class.java).use { scenario ->
            awaitReady(scenario)
            scenario.onActivity { useFixture(it) }
            awaitJs(scenario, "window.results || null")
            var down = SystemClock.uptimeMillis()
            touch(scenario, 0, 500f, 400f, down)
            touch(scenario, 3, 800f, 400f, down)
            touch(scenario, 1, 800f, 400f, down)
            SystemClock.sleep(350)
            assertEquals("[]", evaluate(scenario, "keys"))
            down = SystemClock.uptimeMillis()
            touch(scenario, 0, 500f, 400f, down)
            scenario.onActivity {
                val pointers = Array(2) { index -> android.view.MotionEvent.PointerProperties().apply { id = index } }
                val coords = Array(2) { index -> android.view.MotionEvent.PointerCoords().apply { x = 500f + index * 100; y = 400f } }
                val event = android.view.MotionEvent.obtain(down, SystemClock.uptimeMillis(),
                    android.view.MotionEvent.ACTION_POINTER_DOWN or (1 shl android.view.MotionEvent.ACTION_POINTER_INDEX_SHIFT),
                    2, pointers, coords, 0, 0, 1f, 1f, 0, 0, android.view.InputDevice.SOURCE_TOUCHSCREEN, 0)
                it.web.dispatchTouchEvent(event)
                event.recycle()
            }
            touch(scenario, 1, 800f, 400f, down)
            SystemClock.sleep(350)
            assertEquals("[]", evaluate(scenario, "keys"))
            down = SystemClock.uptimeMillis()
            touch(scenario, 0, 500f, 400f, down)
            SystemClock.sleep(800)
            val ui = androidx.test.platform.app.InstrumentationRegistry.getInstrumentation().uiAutomation
            val deadline = SystemClock.uptimeMillis() + 5000
            var menuFound = false
            while (!menuFound && SystemClock.uptimeMillis() < deadline) {
                menuFound = ui.rootInActiveWindow?.findAccessibilityNodeInfosByText("Ad blocking:")?.isNotEmpty() == true
                if (!menuFound) SystemClock.sleep(100)
            }
            assertTrue("Long press opens native settings", menuFound)
            touch(scenario, 1, 500f, 400f, down)
            assertEquals("[]", evaluate(scenario, "keys"))
            // Native dialog handles Back; it must not leak Escape into the page.
            androidx.test.platform.app.InstrumentationRegistry.getInstrumentation().sendKeyDownUpSync(KeyEvent.KEYCODE_BACK)
            SystemClock.sleep(350)
            assertEquals("[]", evaluate(scenario, "keys"))
        }
    }

    @Test fun googleConsentPagesKeepOrdinaryTouch() {
        ActivityScenario.launch(MainActivity::class.java).use { scenario ->
            awaitReady(scenario)
            scenario.onActivity {
                useFixture(it)
                it.web.loadUrl("https://consent.google.com/tv")
            }
            awaitJs(scenario, "location.hostname==='consent.google.com' && window.results || null")
            val down = SystemClock.uptimeMillis()
            touch(scenario, 0, 100f, 100f, down)
            touch(scenario, 1, 100f, 100f, down)
            awaitJs(scenario, "clicks===1")
            assertEquals("[]", evaluate(scenario, "keys"))
            assertEquals("true", evaluate(scenario, "typeof window.__pakeBlockerCss==='undefined'"))
        }
    }
}
