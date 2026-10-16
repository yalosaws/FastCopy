package com.fastcopy.fastcopy

import android.Manifest
import android.content.Intent
import android.content.pm.PackageManager
import android.net.Uri
import android.os.Build
import android.os.PowerManager
import android.provider.Settings
import io.flutter.embedding.android.FlutterActivity
import io.flutter.embedding.engine.FlutterEngine
import io.flutter.plugin.common.MethodChannel

class MainActivity : FlutterActivity() {
    override fun configureFlutterEngine(flutterEngine: FlutterEngine) {
        super.configureFlutterEngine(flutterEngine)
        MethodChannel(flutterEngine.dartExecutor.binaryMessenger, "fastcopy/native").setMethodCallHandler { call, result ->
            when (call.method) {
                "startSync" -> {
                    SyncConfig.save(
                        this,
                        SyncConfig(
                            baseUrl = call.argument<String>("baseUrl")!!,
                            token = call.argument<String>("token")!!,
                            clientId = call.argument<String>("clientId")!!,
                            deviceName = call.argument<String>("deviceName") ?: Build.MODEL,
                        ),
                    )
                    SyncConfig.setEnabled(this, true)
                    SyncService.stop(this) // restart so a changed server takes effect
                    SyncService.start(this)
                    result.success(true)
                }
                "stopSync" -> {
                    SyncConfig.setEnabled(this, false)
                    SyncService.stop(this)
                    result.success(true)
                }
                "status" -> result.success(status())
                "markSynced" -> {
                    SyncConfig.setLastSynced(this, call.argument<String>("text") ?: "")
                    result.success(null)
                }
                "requestNotifications" -> {
                    if (Build.VERSION.SDK_INT >= 33) requestPermissions(arrayOf(Manifest.permission.POST_NOTIFICATIONS), 1)
                    result.success(null)
                }
                "requestBatteryExemption" -> {
                    startActivity(
                        Intent(Settings.ACTION_REQUEST_IGNORE_BATTERY_OPTIMIZATIONS, Uri.parse("package:$packageName")),
                    )
                    result.success(null)
                }
                "openOverlaySettings" -> {
                    startActivity(Intent(Settings.ACTION_MANAGE_OVERLAY_PERMISSION, Uri.parse("package:$packageName")))
                    result.success(null)
                }
                else -> result.notImplemented()
            }
        }
    }

    private fun status(): Map<String, Any> = mapOf(
        "enabled" to SyncConfig.isEnabled(this),
        "running" to SyncService.running,
        "packageName" to packageName,
        "notifications" to (Build.VERSION.SDK_INT < 33 ||
            checkSelfPermission(Manifest.permission.POST_NOTIFICATIONS) == PackageManager.PERMISSION_GRANTED),
        "batteryUnrestricted" to getSystemService(PowerManager::class.java).isIgnoringBatteryOptimizations(packageName),
        "overlay" to Settings.canDrawOverlays(this),
        "readLogs" to (checkSelfPermission(Manifest.permission.READ_LOGS) == PackageManager.PERMISSION_GRANTED),
    )

    override fun onWindowFocusChanged(hasFocus: Boolean) {
        super.onWindowFocusChanged(hasFocus)
        if (!hasFocus || !SyncConfig.isEnabled(this)) return
        if (!SyncService.running) SyncService.start(this)
        // While the app is focused Android lets us read the clipboard: send anything new copied on the phone.
        ClipboardBridge.send(this, ClipboardBridge.readText(this), manual = false)
    }
}
