package io.github.ltanedo.youtubetv

import android.content.Context
import android.view.GestureDetector
import android.view.KeyEvent
import android.view.MotionEvent
import kotlin.math.abs

/** A touchscreen acts as a remote touchpad, never as a second DOM click source. */
class TouchNavigation(context: Context, private val key: (Int) -> Unit, settings: () -> Unit) {
    private val distance = 48f * context.resources.displayMetrics.density
    private var startX = 0f
    private var startY = 0f
    private var tracking = false
    private var held = false
    private val detector = GestureDetector(context, object : GestureDetector.SimpleOnGestureListener() {
        override fun onDown(e: MotionEvent) = true
        override fun onSingleTapConfirmed(e: MotionEvent): Boolean {
            key(KeyEvent.KEYCODE_ENTER)
            return true
        }
        override fun onDoubleTap(e: MotionEvent): Boolean {
            key(KeyEvent.KEYCODE_ESCAPE)
            return true
        }
        override fun onLongPress(e: MotionEvent) {
            held = true
            settings()
        }
        override fun onScroll(e1: MotionEvent?, e2: MotionEvent, dx: Float, dy: Float) = true
    })

    fun cancel() {
        tracking = false
        val now = android.os.SystemClock.uptimeMillis()
        val event = MotionEvent.obtain(now, now, MotionEvent.ACTION_CANCEL, 0f, 0f, 0)
        detector.onTouchEvent(event)
        event.recycle()
    }

    fun touch(event: MotionEvent) {
        if (event.actionMasked == MotionEvent.ACTION_DOWN) {
            tracking = true
            held = false
            startX = event.x
            startY = event.y
        }
        if (event.pointerCount > 1 || event.actionMasked == MotionEvent.ACTION_CANCEL) {
            cancel()
            return
        }
        if (!tracking) return
        detector.onTouchEvent(event)
        if (event.actionMasked == MotionEvent.ACTION_UP) {
            tracking = false
            val dx = event.x - startX
            val dy = event.y - startY
            if (!held && maxOf(abs(dx), abs(dy)) >= distance) {
                key(if (abs(dx) >= abs(dy)) {
                    if (dx > 0) KeyEvent.KEYCODE_DPAD_RIGHT else KeyEvent.KEYCODE_DPAD_LEFT
                } else {
                    if (dy > 0) KeyEvent.KEYCODE_DPAD_DOWN else KeyEvent.KEYCODE_DPAD_UP
                })
            }
        }
    }
}
