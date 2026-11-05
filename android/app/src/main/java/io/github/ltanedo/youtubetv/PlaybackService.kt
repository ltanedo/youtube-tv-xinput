package io.github.ltanedo.youtubetv

import android.app.*
import android.content.Intent
import android.media.session.MediaSession
import android.media.session.PlaybackState
import android.os.IBinder
import java.lang.ref.WeakReference

/** Keeps an existing WebView playback session eligible for background audio. */
class PlaybackService : Service() {
    private lateinit var session: MediaSession
    override fun onCreate() {
        super.onCreate()
        active = true
        getSystemService(NotificationManager::class.java).createNotificationChannel(
            NotificationChannel("playback", "Playback", NotificationManager.IMPORTANCE_LOW))
        session = MediaSession(this, "YouTubeTV").apply {
            setCallback(object : MediaSession.Callback() {
                override fun onPause() = stopPlayback()
                override fun onStop() = stopPlayback()
            })
            setPlaybackState(PlaybackState.Builder().setActions(PlaybackState.ACTION_PAUSE or PlaybackState.ACTION_STOP)
                .setState(PlaybackState.STATE_PLAYING, PlaybackState.PLAYBACK_POSITION_UNKNOWN, 1f).build())
            isActive = true
        }
    }
    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        if (intent?.action == "pause") { stopPlayback(); return START_NOT_STICKY }
        val open = PendingIntent.getActivity(this, 0, Intent(this, MainActivity::class.java)
            .addFlags(Intent.FLAG_ACTIVITY_SINGLE_TOP or Intent.FLAG_ACTIVITY_CLEAR_TOP), PendingIntent.FLAG_IMMUTABLE)
        val pause = PendingIntent.getService(this, 1, Intent(this, PlaybackService::class.java).setAction("pause"), PendingIntent.FLAG_IMMUTABLE)
        val notification = Notification.Builder(this, "playback")
            .setSmallIcon(android.R.drawable.ic_media_play).setContentTitle("YouTubeTV")
            .setContentText("Background playback enabled").setContentIntent(open).setOngoing(true)
            .addAction(Notification.Action.Builder(android.R.drawable.ic_media_pause, "Pause", pause).build())
            .setStyle(Notification.MediaStyle().setMediaSession(session.sessionToken).setShowActionsInCompactView(0)).build()
        startForeground(1, notification)
        if (owner?.get() == null) stopSelf()
        return START_NOT_STICKY
    }
    private fun stopPlayback() { owner?.get()?.pausePlayback(); stopSelf() }
    override fun onTaskRemoved(rootIntent: Intent?) { stopPlayback(); super.onTaskRemoved(rootIntent) }
    override fun onDestroy() {
        active = false
        session.release()
        stopForeground(STOP_FOREGROUND_REMOVE)
        super.onDestroy()
    }
    override fun onBind(intent: Intent?): IBinder? = null
    companion object {
        var owner: WeakReference<MainActivity>? = null
        var active = false
            private set
    }
}
