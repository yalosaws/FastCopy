import 'dart:async';
import 'dart:convert';
import 'dart:io';
import 'dart:math';

import 'package:flutter/foundation.dart';
import 'package:flutter/services.dart';
import 'package:shared_preferences/shared_preferences.dart';

import 'api.dart';
import 'clipboard_sync.dart';
import 'native_bridge.dart';

enum Connection { disconnected, connecting, connected }

class AppState extends ChangeNotifier implements SyncHost {
  final SharedPreferences _prefs;
  late final String clientId;

  ServerConfig? config;
  FastCopyApi? _api;
  List<Item> items = [];
  Connection connection = Connection.disconnected;
  AndroidStatus? android;

  /// Short message for the UI (e.g. "已复制电脑上的文字"), cleared after it is shown.
  final messages = StreamController<String>.broadcast();

  ClipboardSync? _sync;
  StreamSubscription<SseEvent>? _sub;
  Timer? _retry;
  int _generation = 0;

  AppState(this._prefs) {
    clientId = _prefs.getString('clientId') ?? _newId();
    _prefs.setString('clientId', clientId);
    final saved = _prefs.getString('server');
    if (saved != null) config = ServerConfig.fromJson(jsonDecode(saved) as Map<String, dynamic>);
    // Android syncs the clipboard natively in the background; iOS only can while the app is open.
    if (Platform.isIOS) _sync = ClipboardSync(this, clientId);
  }

  static String _newId() {
    final r = Random.secure();
    return List.generate(16, (_) => r.nextInt(16).toRadixString(16)).join();
  }

  String get deviceName => Platform.isIOS ? 'iPhone' : 'Android';

  FastCopyApi? get api => _api;

  // --- lifecycle -------------------------------------------------------------

  Future<void> start() async {
    if (Platform.isAndroid) await refreshAndroid();
    _connect();
  }

  Future<void> setConfig(ServerConfig cfg) async {
    config = cfg;
    await _prefs.setString('server', jsonEncode(cfg.toJson()));
    // New computer: forget sync bookkeeping from the old one.
    lastSeenId = null;
    lastSynced = null;
    if (Platform.isAndroid) await setAndroidSync(true);
    _connect();
  }

  Future<void> onResume() async {
    if (Platform.isAndroid) await refreshAndroid();
    if (connection != Connection.connected) {
      _connect();
    } else {
      await _syncOnResume();
    }
  }

  void _connect() {
    final cfg = config;
    _sub?.cancel();
    _retry?.cancel();
    _api?.close();
    if (cfg == null) return;
    final gen = ++_generation;
    final api = _api = FastCopyApi(cfg, clientId: clientId, deviceName: deviceName);
    connection = Connection.connecting;
    notifyListeners();

    void retry() {
      if (gen != _generation) return;
      connection = Connection.disconnected;
      notifyListeners();
      _retry = Timer(const Duration(seconds: 3), _connect);
    }

    _sub = api.events().listen((e) async {
      if (gen != _generation) return;
      if (e.event == 'init') {
        connection = Connection.connected;
        items = (jsonDecode(e.data) as List).map((x) => Item.fromJson(x as Map<String, dynamic>)).toList();
        notifyListeners();
        await _syncOnResume();
      } else if (e.event == 'add') {
        final item = Item.fromJson(jsonDecode(e.data) as Map<String, dynamic>);
        items = [...items, item];
        notifyListeners();
        if (_sync != null && await _sync!.onItem(item)) messages.add('已复制电脑上的文字');
      } else if (e.event == 'remove') {
        final id = (jsonDecode(e.data) as Map<String, dynamic>)['id'];
        items = items.where((i) => i.id != id).toList();
        notifyListeners();
      }
    }, onError: (_) => retry(), onDone: retry, cancelOnError: true);
  }

  Future<void> _syncOnResume() async {
    final sync = _sync;
    if (sync == null || connection != Connection.connected) return;
    try {
      final msg = await sync.onResume(items);
      if (msg != null) messages.add(msg);
    } catch (e) {
      debugPrint('sync failed: $e');
    }
  }

  // --- actions ---------------------------------------------------------------

  Future<void> sendText(String text) async {
    await _api!.sendText(text);
    await markSynced(text); // it is now on the computer's clipboard too
  }

  /// Records [text] as present on both devices so neither side echoes it back.
  Future<void> markSynced(String text) async {
    lastSynced = text;
    if (Platform.isAndroid) await NativeBridge.markSynced(text);
  }

  Future<void> delete(Item item) async => _api?.delete(item.id);

  Future<void> refreshAndroid() async {
    android = await NativeBridge.status();
    notifyListeners();
  }

  Future<void> setAndroidSync(bool on) async {
    final cfg = config;
    if (on && cfg != null) {
      await NativeBridge.requestNotifications();
      await NativeBridge.startSync(cfg, clientId);
    } else {
      await NativeBridge.stopSync();
    }
    // The service starts asynchronously.
    await Future<void>.delayed(const Duration(milliseconds: 500));
    await refreshAndroid();
  }

  // --- SyncHost (iOS foreground sync) -----------------------------------------

  @override
  Future<String?> readClipboard() async {
    // hasStrings doesn't trigger the iOS paste prompt, so only read when there's text.
    if (!await Clipboard.hasStrings()) return null;
    return (await Clipboard.getData(Clipboard.kTextPlain))?.text;
  }

  @override
  Future<void> writeClipboard(String text) => Clipboard.setData(ClipboardData(text: text));

  @override
  Future<void> send(String text) async => _api!.sendText(text);

  @override
  String? get lastSynced => _prefs.getString('lastSynced');

  @override
  set lastSynced(String? v) => v == null ? _prefs.remove('lastSynced') : _prefs.setString('lastSynced', v);

  @override
  String? get lastSeenId => _prefs.getString('lastSeenId');

  @override
  set lastSeenId(String? v) => v == null ? _prefs.remove('lastSeenId') : _prefs.setString('lastSeenId', v);

  @override
  void dispose() {
    _generation++;
    _sub?.cancel();
    _retry?.cancel();
    _api?.close();
    messages.close();
    super.dispose();
  }
}
