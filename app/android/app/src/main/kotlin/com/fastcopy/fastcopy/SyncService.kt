package com.fastcopy.fastcopy

import android.Manifest
import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.app.Service
import android.content.ClipboardManager
import android.content.Context
import android.content.Intent
import android.content.pm.PackageManager
import android.content.pm.ServiceInfo
import android.os.Build
import android.os.IBinder
import android.provider.Settings
import androidx.core.app.NotificationCompat
import androidx.core.app.ServiceCompat
import androidx.core.content.ContextCompat
import org.json.JSONArray
import org.json.JSONObject
import java.net.HttpURLConnection
import java.net.URL

/**
 * Keeps a live connection to the computer and writes text copied there straight into the phone's clipboard,
 * even while FastCopy is in the background.
 */
class SyncService : Service() {
    companion object {
        private const val CHANNEL_ID = "sync"
        private const val NOTIFICATION_ID = 1

        @Volatile
        var running = false
            private set

        fun start(ctx: Context) = ContextCompat.startForegroundService(ctx, Intent(ctx, SyncService::class.java))

        fun stop(ctx: Context) = ctx.stopService(Intent(ctx, SyncService::class.java))

        /** Automatic phone → computer sync needs READ_LOGS (granted once via adb) and the overlay permission. */
        fun canAutoSend(ctx: Context) =
            ctx.checkSelfPermission(Manifest.permission.READ_LOGS) == PackageManager.PERMISSION_GRANTED &&
                Settings.canDrawOverlays(ctx)
    }

    @Volatile
    private var stopped = false
    private var worker: Thread? = null

    @Volatile
    private var connection: HttpURLConnection? = null
    private var logcat: LogcatWatcher? = null
    private var status = "连接中…"
    private var latest: String? = null

    // Registering a listener makes the system log a denial for us whenever the clipboard changes in the background,
    // which is what LogcatWatcher looks for.
    private val clipListener = ClipboardManager.OnPrimaryClipChangedListener {}

    override fun onBind(intent: Intent?): IBinder? = null

    override fun onCreate() {
        super.onCreate()
        val nm = getSystemService(NotificationManager::class.java)
        nm.createNotificationChannel(NotificationChannel(CHANNEL_ID, "剪贴板同步", NotificationManager.IMPORTANCE_LOW))
        ServiceCompat.startForeground(
            this,
            NOTIFICATION_ID,
            buildNotification(),
            if (Build.VERSION.SDK_INT >= 34) ServiceInfo.FOREGROUND_SERVICE_TYPE_SPECIAL_USE else 0,
        )
        running = true
    }

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        if (worker == null) {
            worker = Thread(::runLoop, "fastcopy-sync").also { it.start() }
        }
        if (logcat == null && canAutoSend(this)) {
            (getSystemService(CLIPBOARD_SERVICE) as ClipboardManager).addPrimaryClipChangedListener(clipListener)
            logcat = LogcatWatcher(packageName) {
                // Ignore the change we caused ourselves by writing text from the computer.
                if (System.currentTimeMillis() - ClipboardBridge.lastWriteAt > 1500) {
                    startActivity(
                        Intent(this, ClipboardReaderActivity::class.java)
                            .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_NO_ANIMATION),
                    )
                }
            }.also { it.start() }
        }
        return START_STICKY
    }

    override fun onDestroy() {
        stopped = true
        running = false
        connection?.disconnect()
        worker?.interrupt()
        logcat?.stop()
        (getSystemService(CLIPBOARD_SERVICE) as ClipboardManager).removePrimaryClipChangedListener(clipListener)
        super.onDestroy()
    }

    private fun runLoop() {
        var backoff = 1000L
        while (!stopped) {
            val cfg = SyncConfig.load(this) ?: break
            try {
                val conn = Api.openEvents(cfg)
                connection = conn
                setStatus("已连接 ${URL(cfg.baseUrl).host}")
                backoff = 1000L
                Api.readEvents(conn.inputStream) { event, data -> handle(cfg, event, data) }
            } catch (e: Exception) {
                // fall through to reconnect
            } finally {
                connection?.disconnect()
                connection = null
            }
            if (stopped) break
            setStatus("连接断开，重连中…")
            try {
                Thread.sleep(backoff)
            } catch (e: InterruptedException) {
                break
            }
            backoff = (backoff * 2).coerceAtMost(30_000L)
        }
    }

    private fun handle(cfg: SyncConfig, event: String, data: String) {
        when (event) {
            "init" -> {
                val items = JSONArray(data)
                var newest: JSONObject? = null
                for (i in 0 until items.length()) {
                    val it = items.getJSONObject(i)
                    if (it.optString("type") == "text") newest = it
                }
                val item = newest ?: return
                val seen = SyncConfig.lastSeenId(this)
                SyncConfig.setLastSeenId(this, item.getString("id"))
                // First connection ever: just remember where we are. Otherwise catch up on text copied while offline.
                if (seen != null && seen != item.getString("id")) apply(cfg, item)
            }
            "add" -> {
                val item = JSONObject(data)
                if (item.optString("type") != "text") return
                SyncConfig.setLastSeenId(this, item.getString("id"))
                apply(cfg, item)
            }
        }
    }

    private fun apply(cfg: SyncConfig, item: JSONObject) {
        if (item.optString("client") == cfg.clientId) return // our own text
        val text = item.optString("text")
        if (text.isEmpty() || text == SyncConfig.lastSynced(this)) return
        ClipboardBridge.write(this, text)
        latest = text
        refreshNotification()
    }

    private fun setStatus(s: String) {
        status = s
        refreshNotification()
    }

    private fun refreshNotification() {
        getSystemService(NotificationManager::class.java).notify(NOTIFICATION_ID, buildNotification())
    }

    private fun buildNotification(): Notification {
        val flags = PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT
        val open = PendingIntent.getActivity(this, 0, Intent(this, MainActivity::class.java), flags)
        val send = PendingIntent.getActivity(
            this,
            1,
            Intent(this, ClipboardReaderActivity::class.java).putExtra(ClipboardReaderActivity.EXTRA_MANUAL, true),
            flags,
        )
        val preview = latest?.let { "已同步：" + it.replace('\n', ' ').take(60) }
        return NotificationCompat.Builder(this, CHANNEL_ID)
            .setSmallIcon(R.drawable.ic_stat_sync)
            .setContentTitle("FastCopy · $status")
            .setContentText(preview ?: "电脑上复制的文字会自动进入手机剪贴板")
            .setOngoing(true)
            .setOnlyAlertOnce(true)
            .setContentIntent(open)
            .addAction(0, "发送剪贴板到电脑", send)
            .build()
    }
}
