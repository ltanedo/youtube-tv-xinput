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
        window.captionEvents=0;window.addEventListener('pake:captions-toggle',()=>captionEvents++);
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
            scenario.onActivity { ready = it.ready }
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
                    KeyEvent.KEYCODE_BUTTON_B, KeyEvent.KEYCODE_BUTTON_X, KeyEvent.KEYCODE_BUTTON_L2)) {
                    activity.dispatchKeyEvent(KeyEvent(KeyEvent.ACTION_DOWN, key))
                    activity.dispatchKeyEvent(KeyEvent(KeyEvent.ACTION_UP, key))
                }
            }
            awaitJs(scenario, "keys.length===4 && captionEvents===1")
            assertEquals("[39,13,27,32]", evaluate(scenario, "keys"))
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
}
