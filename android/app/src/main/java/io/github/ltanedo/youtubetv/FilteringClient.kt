package io.github.ltanedo.youtubetv

import android.net.Uri
import android.webkit.WebResourceRequest
import android.webkit.WebResourceResponse
import android.webkit.WebView
import android.webkit.WebViewClient
import org.json.JSONObject
import java.io.ByteArrayInputStream
import java.util.concurrent.atomic.AtomicLong

open class FilteringClient(private val enabled: () -> Boolean) : WebViewClient() {
    @Volatile var topUrl = "https://www.youtube.com/tv"
    val blocked = AtomicLong()
    val failures = AtomicLong()

    override fun onPageStarted(view: WebView, url: String, favicon: android.graphics.Bitmap?) {
        topUrl = url
    }

    override fun shouldOverrideUrlLoading(view: WebView, request: WebResourceRequest): Boolean {
        // No intent:, file:, arbitrary app launches or untrusted top-level pages.
        return request.isForMainFrame && !allowedNavigation(request.url)
    }

    override fun shouldInterceptRequest(view: WebView?, request: WebResourceRequest): WebResourceResponse? {
        if (!enabled() || request.isForMainFrame) return null
        val source = request.requestHeaders.entries.firstOrNull { it.key.equals("Referer", true) }?.value ?: topUrl
        return try {
            val decision = JSONObject(NativeBlocker.check(request.url.toString(), source, resourceType(request), request.method))
            if (!decision.getBoolean("blocked")) return null
            blocked.incrementAndGet()
            val redirect = decision.optJSONArray("redirect")
            if (redirect != null) {
                val data = redirect.getJSONArray(1)
                WebResourceResponse(redirect.getString(0), null,
                    ByteArrayInputStream(ByteArray(data.length()) { data.getInt(it).toByte() }))
            } else {
                WebResourceResponse("text/plain", "utf-8", 403, "Blocked", emptyMap(), ByteArrayInputStream(byteArrayOf()))
            }
        } catch (_: Exception) {
            // Runtime failures fail open, but remain visible in native diagnostics.
            failures.incrementAndGet()
            null
        }
    }

    companion object {
        private val youtubeHosts = setOf("youtube.com", "www.youtube.com", "m.youtube.com", "music.youtube.com",
            "youtube-nocookie.com", "www.youtube-nocookie.com")
        fun isYouTube(uri: Uri): Boolean = uri.scheme == "https" && uri.host in youtubeHosts
        fun allowedNavigation(uri: Uri): Boolean = isYouTube(uri) ||
            (uri.scheme == "https" && uri.host in setOf("accounts.google.com", "consent.youtube.com", "consent.google.com"))

        // Android does not expose a resource type. Prefer Fetch Metadata when
        // available; otherwise infer conservatively, documenting the limitation.
        fun resourceType(request: WebResourceRequest): String {
            val dest = request.requestHeaders.entries.firstOrNull { it.key.equals("Sec-Fetch-Dest", true) }?.value
            when (dest) {
                "script", "image", "font" -> return dest
                "style" -> return "stylesheet"
                "audio", "video" -> return "media"
                "iframe", "frame" -> return "subdocument"
                "empty" -> return "xmlhttprequest"
            }
            val path = request.url.path.orEmpty().lowercase()
            return when {
                path.endsWith(".js") -> "script"
                path.endsWith(".css") -> "stylesheet"
                Regex("\\.(png|jpe?g|webp|gif|svg)$").containsMatchIn(path) -> "image"
                Regex("\\.(woff2?|ttf)$").containsMatchIn(path) -> "font"
                path.contains("/youtubei/") || path.endsWith("/initplayback") -> "xmlhttprequest"
                path.endsWith("/videoplayback") -> "media"
                else -> "other"
            }
        }
    }
}
