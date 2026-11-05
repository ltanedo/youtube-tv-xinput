package io.github.ltanedo.youtubetv

object NativeBlocker {
    init { System.loadLibrary("yttv_android_blocker") }
    external fun initialize(): String
    external fun check(url: String, source: String, kind: String, method: String): String
}
