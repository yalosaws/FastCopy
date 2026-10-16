import 'api.dart';

/// Abstracts the phone clipboard and persisted sync state so the sync rules can be tested.
abstract class SyncHost {
  Future<String?> readClipboard();
  Future<void> writeClipboard(String text);
  Future<void> send(String text);

  /// Text most recently exchanged with the computer in either direction (prevents echo loops).
  String? get lastSynced;
  set lastSynced(String? v);

  /// Id of the newest computer item already handled.
  String? get lastSeenId;
  set lastSeenId(String? v);
}

/// Foreground clipboard sync, used where the OS won't let us sync in the background (iOS).
class ClipboardSync {
  final SyncHost host;
  final String clientId;

  ClipboardSync(this.host, this.clientId);

  /// Called when the app comes to the foreground with the server's current items (oldest first).
  /// Something newly copied on the phone wins; otherwise catch up on what was copied on the computer.
  /// Returns a short description of what happened, or null if nothing did.
  Future<String?> onResume(List<Item> items) async {
    final remote = _newestForeignText(items);
    final local = await host.readClipboard();

    if (host.lastSynced == null && host.lastSeenId == null) {
      // First launch: remember the current state without overwriting anything on either side.
      host.lastSynced = local ?? '';
      if (remote != null) host.lastSeenId = remote.id;
      return null;
    }
    if (local != null && local.trim().isNotEmpty && local != host.lastSynced) {
      await host.send(local);
      host.lastSynced = local;
      if (remote != null) host.lastSeenId = remote.id;
      return '已把手机剪贴板发送到电脑';
    }
    if (remote == null) return null;
    host.lastSeenId = remote.id;
    if (remote.text == null || remote.text == host.lastSynced) return null;
    await _apply(remote.text!);
    return '已复制电脑上的文字';
  }

  /// Called for each live item while the app is open.
  Future<bool> onItem(Item item) async {
    if (!item.isText || item.client == clientId) return false;
    host.lastSeenId = item.id;
    if (item.text == null || item.text!.isEmpty || item.text == host.lastSynced) return false;
    await _apply(item.text!);
    return true;
  }

  Future<void> _apply(String text) async {
    host.lastSynced = text;
    await host.writeClipboard(text);
  }

  Item? _newestForeignText(List<Item> items) {
    for (final it in items.reversed) {
      if (it.isText) return (it.client == clientId || it.id == host.lastSeenId) ? null : it;
    }
    return null;
  }
}
