package com.fastcopy.fastcopy

import android.content.ClipData
import android.content.ClipboardManager
import android.content.Context
import android.os.Handler
import android.os.Looper
import android.widget.Toast
import java.io.BufferedReader
import java.io.InputStream
import java.io.InputStreamReader
import java.net.HttpURLConnection
import java.net.URL
import java.net.URLEncoder

/** Connection settings handed over from the Flutter UI, plus sync bookkeeping. */
data class SyncConfig(val baseUrl: String, val token: String, val clientId: String, val deviceName: String) {
    companion object {
        private const val FILE = "fastcopy_sync"

        private fun prefs(ctx: Context) = ctx.getSharedPreferences(FILE, Context.MODE_PRIVATE)

        fun load(ctx: Context): SyncConfig? {
            val p = prefs(ctx)
            val base = p.getString("baseUrl", null) ?: return null
            val token = p.getString("token", null) ?: return null
            val client = p.getString("clientId", null) ?: return null
            return SyncConfig(base, token, client, p.getString("deviceName", null) ?: "Android")
        }

        fun save(ctx: Context, cfg: SyncConfig) {
            prefs(ctx).edit()
                .putString("baseUrl", cfg.baseUrl.trimEnd('/'))
                .putString("token", cfg.token)
                .putString("clientId", cfg.clientId)
                .putString("deviceName", cfg.deviceName)
                .apply()
        }

        fun isEnabled(ctx: Context) = prefs(ctx).getBoolean("enabled", false)
        fun setEnabled(ctx: Context, on: Boolean) = prefs(ctx).edit().putBoolean("enabled", on).apply()

        /** Id of the newest text item already handled, so reconnects don't re-apply old text. */
        fun lastSeenId(ctx: Context): String? = prefs(ctx).getString("lastSeenId", null)
        fun setLastSeenId(ctx: Context, id: String) = prefs(ctx).edit().putString("lastSeenId", id).apply()

        /** Text most recently exchanged with the computer in either direction; used to avoid echo loops. */
        fun lastSynced(ctx: Context): String? = prefs(ctx).getString("lastSynced", null)
        fun setLastSynced(ctx: Context, text: String) = prefs(ctx).edit().putString("lastSynced", text).apply()
    }
}

object Api {
    private fun url(cfg: SyncConfig, path: String) =
        URL("${cfg.baseUrl}$path?token=${URLEncoder.encode(cfg.token, "UTF-8")}")

    private fun HttpURLConnection.identify(cfg: SyncConfig) {
        setRequestProperty("X-FastCopy-Client", cfg.clientId)
        setRequestProperty("X-FastCopy-Device", URLEncoder.encode(cfg.deviceName, "UTF-8").replace("+", "%20"))
    }

    fun postText(cfg: SyncConfig, text: String): Boolean {
        val conn = url(cfg, "/api/text").openConnection() as HttpURLConnection
        return try {
            conn.requestMethod = "POST"
            conn.doOutput = true
            conn.connectTimeout = 5000
            conn.readTimeout = 10000
            conn.setRequestProperty("Content-Type", "text/plain; charset=utf-8")
            conn.identify(cfg)
            conn.outputStream.use { it.write(text.toByteArray(Charsets.UTF_8)) }
            conn.responseCode == 201
        } finally {
            conn.disconnect()
        }
    }

    fun openEvents(cfg: SyncConfig): HttpURLConnection {
        val conn = url(cfg, "/events").openConnection() as HttpURLConnection
        conn.connectTimeout = 5000
        conn.readTimeout = 60000 // the server pings every 25s
        conn.setRequestProperty("Accept", "text/event-stream")
        conn.identify(cfg)
        if (conn.responseCode != 200) {
            conn.disconnect()
            throw IllegalStateException("HTTP ${conn.responseCode}")
        }
        return conn
    }

    /** Minimal Server-Sent Events reader: calls [onEvent] for each complete event until the stream ends. */
    fun readEvents(stream: InputStream, onEvent: (String, String) -> Unit) {
        val reader = BufferedReader(InputStreamReader(stream, Charsets.UTF_8))
        var event = "message"
        val data = StringBuilder()
        while (true) {
            val line = reader.readLine() ?: return
            when {
                line.isEmpty() -> {
                    if (data.isNotEmpty()) onEvent(event, data.toString())
                    event = "message"
                    data.setLength(0)
                }
                line.startsWith(":") -> Unit
                line.startsWith("event:") -> event = line.substring(6).trim()
                line.startsWith("data:") -> {
                    if (data.isNotEmpty()) data.append('\n')
                    data.append(line.substring(5).removePrefix(" "))
                }
            }
        }
    }
}

object ClipboardBridge {
    private val main = Handler(Looper.getMainLooper())

    @Volatile
    var lastWriteAt = 0L
        private set

    private fun manager(ctx: Context) = ctx.getSystemService(Context.CLIPBOARD_SERVICE) as ClipboardManager

    /** Writing is allowed from the background on every Android version. */
    fun write(ctx: Context, text: String) {
        SyncConfig.setLastSynced(ctx, text)
        main.post {
            lastWriteAt = System.currentTimeMillis()
            manager(ctx).setPrimaryClip(ClipData.newPlainText("FastCopy", text))
        }
    }

    /** Only works while one of our windows has focus (Android 10+). */
    fun readText(ctx: Context): String? =
        manager(ctx).primaryClip?.takeIf { it.itemCount > 0 }?.getItemAt(0)?.coerceToText(ctx)?.toString()

    /**
     * Sends [text] to the computer unless it is empty or already in sync.
     * [manual] sends show a toast with the result.
     */
    fun send(ctx: Context, text: String?, manual: Boolean) {
        val app = ctx.applicationContext
        val cfg = SyncConfig.load(app)
        if (cfg == null) {
            if (manual) toast(app, "请先在 FastCopy 中连接电脑")
            return
        }
        if (text.isNullOrBlank()) {
            if (manual) toast(app, "剪贴板里没有文字")
            return
        }
        if (text == SyncConfig.lastSynced(app)) {
            if (manual) toast(app, "电脑上已经是这段文字了")
            return
        }
        Thread {
            val ok = try {
                Api.postText(cfg, text)
            } catch (e: Exception) {
                false
            }
            if (ok) SyncConfig.setLastSynced(app, text)
            if (manual || !ok) toast(app, if (ok) "已发送到电脑" else "发送失败，请检查电脑上的 FastCopy 是否在运行")
        }.start()
    }

    fun toast(ctx: Context, msg: String) = main.post { Toast.makeText(ctx, msg, Toast.LENGTH_SHORT).show() }
}
