package io.github.ltanedo.youtubetv

import android.app.NotificationManager
import android.os.Handler
import android.os.Looper
import android.os.SystemClock
import android.view.KeyEvent
import android.view.accessibility.AccessibilityNodeInfo
import android.webkit.WebResourceRequest
import android.webkit.WebResourceResponse
import android.webkit.WebView
import androidx.test.core.app.ActivityScenario
import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import org.junit.Assert.*
import org.junit.Test
import org.junit.runner.RunWith
import java.io.ByteArrayInputStream
import java.util.concurrent.CountDownLatch
import java.util.concurrent.TimeUnit

@RunWith(AndroidJUnit4::class)
class PlaybackSettingsTest {
    private val instrumentation = InstrumentationRegistry.getInstrumentation()
    private lateinit var activity: MainActivity
    private fun main(action: () -> Unit) {
        val latch = CountDownLatch(1)
        var error: Throwable? = null
        Handler(Looper.getMainLooper()).post { try { action() } catch (e: Throwable) { error = e } finally { latch.countDown() } }
        check(latch.await(10, TimeUnit.SECONDS))
        error?.let { throw it }
    }
    private fun eval(script: String): String {
        var result = "null"
        val latch = CountDownLatch(1)
        main { activity.web.evaluateJavascript(script) { result = it; latch.countDown() } }
        check(latch.await(10, TimeUnit.SECONDS))
        return result
    }
    private fun await(condition: () -> Boolean) {
        val end = SystemClock.elapsedRealtime() + 15000
        while (SystemClock.elapsedRealtime() < end) { if (condition()) return; SystemClock.sleep(100) }
        error("Playback/settings condition timed out")
    }
    private fun shell(command: String) { instrumentation.uiAutomation.executeShellCommand(command).close() }
    private fun setup(scenario: ActivityScenario<MainActivity>) {
        scenario.onActivity { activity = it }
        await { var ready = false; main { ready = activity.ready }; ready }
        main {
            activity.setFillScreen(false)
            activity.setBackgroundPlay(true)
            activity.web.webViewClient = object : FilteringClient({ activity.blockingEnabled }) {
                override fun shouldInterceptRequest(view: WebView?, request: WebResourceRequest): WebResourceResponse {
                    if (request.url.path == "/fixture.mp4") return WebResourceResponse("video/mp4", null,
                        instrumentation.context.assets.open("playback-fixture.mp4"))
                    val html = """<!doctype html><html><body class="WEB_PAGE_TYPE_WATCH">
                        <video class="html5-main-video" playsinline loop src="/fixture.mp4"></video>
                        <script>window.keys=[];document.addEventListener('keydown',e=>keys.push(e.keyCode));</script>
                        </body></html>"""
                    return WebResourceResponse("text/html", "UTF-8", ByteArrayInputStream(html.toByteArray()))
                }
            }
            activity.web.loadUrl(MainActivity.START_URL)
        }
        await { eval("!!document.querySelector('video') && document.querySelector('video').readyState>=2") == "true" }
    }
    private fun menuClick(text: String) {
        main { activity.dispatchKeyEvent(KeyEvent(KeyEvent.ACTION_DOWN, KeyEvent.KEYCODE_MENU)) }
        await {
            val node = instrumentation.uiAutomation.rootInActiveWindow?.findAccessibilityNodeInfosByText(text)?.firstOrNull()
            node?.performAction(AccessibilityNodeInfo.ACTION_CLICK) == true
        }
    }
    private fun time() = eval("document.querySelector('video').currentTime").toDouble()
    private fun play() {
        eval("document.querySelector('video').play();true")
        await { time() > .5 && PlaybackService.active }
    }
    private fun foreground() {
        shell("input keyevent 224")
        shell("wm dismiss-keyguard")
        shell("am start -n io.github.ltanedo.youtubetv/.MainActivity")
        SystemClock.sleep(1000)
    }

    @Test fun settingsZoomCoversViewportAndPersistsWithoutReloading() {
        ActivityScenario.launch(MainActivity::class.java).use { scenario ->
            setup(scenario)
            assertEquals("\"contain\"", eval("getComputedStyle(document.querySelector('video')).objectFit"))
            eval("window.keepDocument=123")
            menuClick("Zoom:")
            await { eval("getComputedStyle(document.querySelector('video')).objectFit") == "\"cover\"" }
            assertEquals("123", eval("window.keepDocument"))
            assertEquals("true", eval("(()=>{const b=document.querySelector('video').getBoundingClientRect();return Math.abs(b.width-innerWidth)<1&&Math.abs(b.height-innerHeight)<1})()"))
            main { activity.web.reload() }
            await { eval("document.documentElement.dataset.yttvFit") == "\"fill\"" }
            menuClick("Zoom:")
            await { eval("document.documentElement.dataset.yttvFit") == "\"fit\"" }
            // Android fit must win over the desktop ultrawide default, regardless of CSS order.
            eval("document.documentElement.setAttribute('data-pake-fill','')")
            assertEquals("\"contain\"", eval("getComputedStyle(document.querySelector('video')).objectFit"))
            menuClick("Background play:")
            main { assertFalse(activity.backgroundPlay) }
            menuClick("Background play:")
            main { assertTrue(activity.backgroundPlay) }
        }
    }

    @Test fun backgroundVideoAdvancesOnHomeAndScreenOffAndNotificationPauses() {
        ActivityScenario.launch(MainActivity::class.java).use { scenario ->
            try {
                setup(scenario)
                play()
                var before = time()
                shell("input keyevent 3")
                SystemClock.sleep(4000)
                assertTrue("Playback advances behind Home", time() > before + 2)
                assertTrue(PlaybackService.active)
                before = time()
                shell("input keyevent 223")
                SystemClock.sleep(4000)
                assertTrue("Playback advances with screen off", time() > before + 2)
                main {
                    val notification = activity.getSystemService(NotificationManager::class.java).activeNotifications.first { it.id == 1 }
                    notification.notification.actions[0].actionIntent.send()
                }
                await { eval("document.querySelector('video').paused") == "true" && !PlaybackService.active }
                val paused = time()
                SystemClock.sleep(1000)
                assertEquals(paused, time(), .1)
            } finally { foreground() }
        }
    }

    @Test fun bufferingKeepsPlaybackServiceAndBufferedStallRecovers() {
        ActivityScenario.launch(MainActivity::class.java).use { scenario ->
            setup(scenario)
            // A fully loaded Blob is seekable in WebView; streaming interception
            // responses without an HTTP range server report a zero seekable end.
            eval("fetch('/fixture.mp4').then(r=>r.blob()).then(b=>{document.querySelector('video').src=URL.createObjectURL(b)});true")
            await { eval("(()=>{const v=document.querySelector('video');return v.currentSrc.startsWith('blob:')&&v.readyState>=2&&v.seekable.length>0&&v.seekable.end(0)>2})()") == "true" }
            play()
            eval("Object.defineProperty(document.querySelector('video'),'readyState',{configurable:true,get:()=>1});true")
            SystemClock.sleep(1500)
            assertTrue("Buffering must not tear down the playback service", PlaybackService.active)
            eval("delete document.querySelector('video').readyState;true")
            // Inject a stuck reported media clock into an otherwise buffered decoder.
            // A real device's rare decoder fault cannot be forced deterministically.
            eval("""
                (()=>{const v=document.querySelector('video'), t=v.currentTime;
                Object.defineProperty(v,'currentTime',{configurable:true,get:()=>t,set:value=>{
                  delete v.currentTime; v.currentTime=value; window.recoveredAt=value;
                }});return true})()
            """.trimIndent())
            val end = SystemClock.elapsedRealtime() + 25000
            val history = mutableListOf<String>()
            while (SystemClock.elapsedRealtime() < end && eval("!!window.recoveredAt") != "true") {
                history.add(eval("""(()=>{const v=document.querySelector('video');return {
                  paused:v.paused,time:Object.getOwnPropertyDescriptor(HTMLMediaElement.prototype,'currentTime').get.call(v),
                  error:v.error&&v.error.code,attempts:window.__yttvRecovery.attempts}})()"""))
                SystemClock.sleep(1000)
            }
            assertEquals(history.toString() + eval("""(()=>{const v=document.querySelector('video');return JSON.stringify({
                state:window.__yttvRecovery,foreground:window.__yttvForeground,time:v.currentTime,
                paused:v.paused,seeking:v.seeking,src:v.currentSrc,
                buffered:Array.from({length:v.buffered.length},(_,i)=>[v.buffered.start(i),v.buffered.end(i)]),
                seekable:Array.from({length:v.seekable.length},(_,i)=>[v.seekable.start(i),v.seekable.end(i)])})})()"""),
                "true", eval("!!window.recoveredAt"))
            assertEquals("\"buffered-stall\"", eval("window.__yttvRecovery.reason"))
            assertEquals("false", eval("document.querySelector('video').paused"))
            val recovered = time()
            SystemClock.sleep(1500)
            assertTrue("Media advances after recovery", time() > recovered + .5)
        }
    }

    @Test fun disabledBackgroundPausesOnHomeAndExitCleansUpService() {
        ActivityScenario.launch(MainActivity::class.java).use { scenario ->
            try {
                setup(scenario)
                main { activity.setBackgroundPlay(false) }
                eval("document.querySelector('video').play();true")
                await { time() > .5 }
                shell("input keyevent 3")
                SystemClock.sleep(1500)
                assertEquals("true", eval("document.querySelector('video').paused"))
                assertFalse(PlaybackService.active)
                foreground()
                main { activity.setBackgroundPlay(true) }
                play()
                main { activity.finish() }
                await { !PlaybackService.active }
            } finally { foreground() }
        }
    }
}
