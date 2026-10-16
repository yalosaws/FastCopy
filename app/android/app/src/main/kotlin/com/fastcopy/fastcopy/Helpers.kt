package com.fastcopy.fastcopy

import android.app.Activity
import android.app.PendingIntent
import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.os.Build
import android.os.Bundle
import android.service.quicksettings.TileService
import java.text.SimpleDateFormat
import java.util.Date
import java.util.Locale

/**
 * Invisible activity that briefly takes focus so Android (10+) lets us read the clipboard, sends it to the
 * computer and closes. Also receives text shared from other apps.
 */
class ClipboardReaderActivity : Activity() {
    companion object {
        const val EXTRA_MANUAL = "manual"
    }

    private var handled = false

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        if (intent?.action == Intent.ACTION_SEND) {
            handled = true
            ClipboardBridge.send(this, intent.getStringExtra(Intent.EXTRA_TEXT), manual = true)
            finishQuietly()
        }
    }

    override fun onWindowFocusChanged(hasFocus: Boolean) {
        super.onWindowFocusChanged(hasFocus)
        if (!hasFocus || handled) return
        handled = true
        val manual = intent?.getBooleanExtra(EXTRA_MANUAL, false) == true
        ClipboardBridge.send(this, ClipboardBridge.readText(this), manual)
        finishQuietly()
    }

    private fun finishQuietly() {
        finish()
        @Suppress("DEPRECATION")
        overridePendingTransition(0, 0)
    }
}

/** Quick Settings tile: one tap sends the phone's clipboard to the computer. */
class SendTileService : TileService() {
    override fun onClick() {
        super.onClick()
        val intent = Intent(this, ClipboardReaderActivity::class.java)
            .putExtra(ClipboardReaderActivity.EXTRA_MANUAL, true)
            .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
        if (Build.VERSION.SDK_INT >= 34) {
            startActivityAndCollapse(PendingIntent.getActivity(this, 2, intent, PendingIntent.FLAG_IMMUTABLE))
        } else {
            @Suppress("DEPRECATION", "StartActivityAndCollapseDeprecated")
            startActivityAndCollapse(intent)
        }
    }
}

/** Restarts syncing after a reboot if it was switched on. */
class BootReceiver : BroadcastReceiver() {
    override fun onReceive(context: Context, intent: Intent) {
        if (intent.action == Intent.ACTION_BOOT_COMPLETED && SyncConfig.isEnabled(context) && SyncConfig.load(context) != null) {
            SyncService.start(context)
        }
    }
}

/**
 * Android 10+ hides clipboard changes from background apps, but the system logs a denial each time it does so.
 * With READ_LOGS granted (once, via adb) we watch for that line and react to the change. Same approach as KDE Connect.
 */
class LogcatWatcher(private val packageName: String, private val onClipboardChanged: () -> Unit) {
    @Volatile
    private var process: Process? = null

    @Volatile
    private var stopped = false

    fun start() {
        Thread({
            try {
                val since = SimpleDateFormat("MM-dd HH:mm:ss.SSS", Locale.US).format(Date())
                val proc = Runtime.getRuntime().exec(arrayOf("logcat", "-T", since, "ClipboardService:E", "*:S"))
                process = proc
                var last = 0L
                proc.inputStream.bufferedReader().forEachLine { line ->
                    if (stopped || !line.contains(packageName)) return@forEachLine
                    val now = System.currentTimeMillis()
                    if (now - last > 500) {
                        last = now
                        onClipboardChanged()
                    }
                }
            } catch (e: Exception) {
                // logcat unavailable: automatic phone → computer sync stays off, manual sending still works
            }
        }, "fastcopy-logcat").start()
    }

    fun stop() {
        stopped = true
        process?.destroy()
    }
}
