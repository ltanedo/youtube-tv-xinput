package io.github.ltanedo.youtubetv

import android.graphics.Bitmap
import android.os.SystemClock
import android.view.KeyEvent
import androidx.test.core.app.ActivityScenario
import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import org.json.JSONObject
import org.junit.Assert.*
import org.junit.Assume.assumeTrue
import org.junit.Test
import org.junit.runner.RunWith
import java.io.File
import java.util.concurrent.CountDownLatch
import java.util.concurrent.TimeUnit

/** Opt-in network smoke test; never claims ad coverage from absence of real ads. */
@RunWith(AndroidJUnit4::class)
class LivePlaybackTest {
    private val instrumentation = InstrumentationRegistry.getInstrumentation()
    private lateinit var activity: MainActivity
    // ActivityScenario.onActivity waits for the UI queue to go idle. A playing
    // WebView can keep Choreographer busy indefinitely; post directly instead.
    private fun onMain(action: (MainActivity) -> Unit) {
        val done = CountDownLatch(1)
        var failure: Throwable? = null
        android.os.Handler(android.os.Looper.getMainLooper()).post {
            try { action(activity) } catch (e: Throwable) { failure = e } finally { done.countDown() }
        }
        check(done.await(10, TimeUnit.SECONDS)) { "Main thread did not respond" }
        failure?.let { throw it }
    }
    private fun eval(script: String): String {
        val done = CountDownLatch(1)
        var result = "null"
        onMain { it.web.evaluateJavascript(script) { value -> result = value; done.countDown() } }
        check(done.await(10, TimeUnit.SECONDS))
        return result
    }
    private fun waitUntil(seconds: Int = 60, condition: () -> Boolean) {
        val deadline = SystemClock.elapsedRealtime() + seconds * 1000
        while (SystemClock.elapsedRealtime() < deadline) {
            if (condition()) return
            SystemClock.sleep(500)
        }
        error("Live playback condition timed out after $seconds seconds")
    }
    private fun screenshot(name: String) {
        val bitmap = instrumentation.uiAutomation.takeScreenshot()
        File(instrumentation.targetContext.getExternalFilesDir(null), name).outputStream().use {
            bitmap.compress(Bitmap.CompressFormat.PNG, 100, it)
        }
        bitmap.recycle()
    }
    private val telemetry = """
        (()=>{const v=document.querySelector('video');return {
        tv:!!document.querySelector('ytlr-app'),title:document.title,
        video:!!v,time:v?v.currentTime:0,paused:v?v.paused:true,
        width:v?v.videoWidth:0,height:v?v.videoHeight:0,
        readyState:v?v.readyState:0,error:v&&v.error?v.error.code:null,
        bodyClass:document.body?document.body.className:''};})()
    """.trimIndent()

    @Test fun liveLeanbackPlaybackAndRemotePauseResume() {
        assumeTrue(InstrumentationRegistry.getArguments().getString("livePlayback") == "true")
        ActivityScenario.launch(MainActivity::class.java).use { scenario ->
            scenario.onActivity { activity = it }
            try {
                waitUntil { var ready = false; onMain { ready = it.ready }; ready }
                waitUntil { eval("!!document.querySelector('ytlr-app')") == "true" }
                SystemClock.sleep(4000)
                screenshot("live-home.png")
                val videoId = InstrumentationRegistry.getArguments().getString("videoId") ?: "aqz-KE-bpKQ"
                require(Regex("[A-Za-z0-9_-]{11}").matches(videoId))
                onMain { it.web.loadUrl("https://www.youtube.com/tv#/watch?v=$videoId") }
                waitUntil(90) {
                    val value = JSONObject(eval(telemetry))
                    value.getDouble("time") > 2 && value.getInt("width") > 0
                }
                val before = JSONObject(eval(telemetry))
                screenshot("live-playing.png")
                SystemClock.sleep(5000)
                val after = JSONObject(eval(telemetry))
                assertTrue("Video clock advances", after.getDouble("time") > before.getDouble("time") + 2)
                onMain {
                    it.dispatchKeyEvent(KeyEvent(KeyEvent.ACTION_DOWN, KeyEvent.KEYCODE_MEDIA_PLAY_PAUSE))
                    it.dispatchKeyEvent(KeyEvent(KeyEvent.ACTION_UP, KeyEvent.KEYCODE_MEDIA_PLAY_PAUSE))
                }
                waitUntil(10) { eval("document.querySelector('video').paused") == "true" }
                screenshot("live-paused.png")
                onMain {
                    it.dispatchKeyEvent(KeyEvent(KeyEvent.ACTION_DOWN, KeyEvent.KEYCODE_MEDIA_PLAY_PAUSE))
                    it.dispatchKeyEvent(KeyEvent(KeyEvent.ACTION_UP, KeyEvent.KEYCODE_MEDIA_PLAY_PAUSE))
                }
                waitUntil(10) { eval("document.querySelector('video').paused") == "false" }
                onMain { it.setBackgroundPlay(true) }
                waitUntil(10) { PlaybackService.active }
                val backgroundBefore = JSONObject(eval(telemetry)).getDouble("time")
                instrumentation.uiAutomation.executeShellCommand("input keyevent 3").close()
                SystemClock.sleep(5000)
                val backgroundAfter = JSONObject(eval(telemetry)).getDouble("time")
                assertTrue("Live video advances behind Home", backgroundAfter > backgroundBefore + 2)
                instrumentation.uiAutomation.executeShellCommand("input keyevent 223").close()
                SystemClock.sleep(5000)
                val screenOffAfter = JSONObject(eval(telemetry)).getDouble("time")
                assertTrue("Live video advances with screen off", screenOffAfter > backgroundAfter + 2)
                val report = JSONObject().put("backgroundPlay", true).put("screenOffPlay", true).put("before", before).put("after", after).put("pauseResume", true)
                onMain { report.put("blockedRequests", it.filtering.blocked.get()).put("filterErrors", it.filtering.failures.get()) }
                File(instrumentation.targetContext.getExternalFilesDir(null), "live-report.json").writeText(report.toString(2))
            } finally {
                instrumentation.uiAutomation.executeShellCommand("input keyevent 224").close()
                instrumentation.uiAutomation.executeShellCommand("wm dismiss-keyguard").close()
                try {
                    screenshot("live-final.png")
                    File(instrumentation.targetContext.getExternalFilesDir(null), "live-final.json").writeText(eval(telemetry))
                } finally {
                    onMain { it.finish() }
                }
            }
        }
    }
}
