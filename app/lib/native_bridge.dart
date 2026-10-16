import 'package:flutter/services.dart';

import 'api.dart';

/// Android background sync, implemented natively in SyncService.kt.
class AndroidStatus {
  final bool enabled, running, notifications, batteryUnrestricted, overlay, readLogs;
  final String packageName;

  AndroidStatus(Map<Object?, Object?> m)
      : enabled = m['enabled'] == true,
        running = m['running'] == true,
        notifications = m['notifications'] == true,
        batteryUnrestricted = m['batteryUnrestricted'] == true,
        overlay = m['overlay'] == true,
        readLogs = m['readLogs'] == true,
        packageName = (m['packageName'] as String?) ?? 'com.fastcopy.fastcopy';

  /// Phone → computer can be fully automatic only with both of these.
  bool get autoSend => overlay && readLogs;

  String get adbCommand => 'adb shell pm grant $packageName android.permission.READ_LOGS';
}

class NativeBridge {
  static const _ch = MethodChannel('fastcopy/native');

  static Future<void> startSync(ServerConfig cfg, String clientId) =>
      _ch.invokeMethod('startSync', {'baseUrl': cfg.baseUrl, 'token': cfg.token, 'clientId': clientId});

  static Future<void> stopSync() => _ch.invokeMethod('stopSync');

  /// Tells the native side this text is already on both devices, so it won't be sent back.
  static Future<void> markSynced(String text) => _ch.invokeMethod('markSynced', {'text': text});

  static Future<AndroidStatus> status() async =>
      AndroidStatus(await _ch.invokeMethod<Map<Object?, Object?>>('status') ?? const {});

  static Future<void> requestNotifications() => _ch.invokeMethod('requestNotifications');
  static Future<void> requestBatteryExemption() => _ch.invokeMethod('requestBatteryExemption');
  static Future<void> openOverlaySettings() => _ch.invokeMethod('openOverlaySettings');
}
