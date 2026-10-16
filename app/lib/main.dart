import 'dart:async';
import 'dart:io';

import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:shared_preferences/shared_preferences.dart';
import 'package:url_launcher/url_launcher.dart';

import 'api.dart';
import 'app_state.dart';
import 'connect_page.dart';
import 'native_bridge.dart';

Future<void> main() async {
  WidgetsFlutterBinding.ensureInitialized();
  final state = AppState(await SharedPreferences.getInstance());
  runApp(FastCopyApp(state: state));
}

class FastCopyApp extends StatelessWidget {
  final AppState state;
  const FastCopyApp({super.key, required this.state});

  @override
  Widget build(BuildContext context) {
    ThemeData theme(Brightness b) => ThemeData(colorSchemeSeed: const Color(0xFF2563EB), brightness: b);
    return MaterialApp(
      title: 'FastCopy',
      theme: theme(Brightness.light),
      darkTheme: theme(Brightness.dark),
      home: HomePage(state: state),
    );
  }
}

class HomePage extends StatefulWidget {
  final AppState state;
  const HomePage({super.key, required this.state});

  @override
  State<HomePage> createState() => _HomePageState();
}

class _HomePageState extends State<HomePage> with WidgetsBindingObserver {
  AppState get s => widget.state;
  final _text = TextEditingController();
  StreamSubscription<String>? _messages;

  @override
  void initState() {
    super.initState();
    WidgetsBinding.instance.addObserver(this);
    _messages = s.messages.stream.listen(_toast);
    s.start();
    if (s.config == null) WidgetsBinding.instance.addPostFrameCallback((_) => _openConnect());
  }

  @override
  void dispose() {
    WidgetsBinding.instance.removeObserver(this);
    _messages?.cancel();
    _text.dispose();
    super.dispose();
  }

  @override
  void didChangeAppLifecycleState(AppLifecycleState state) {
    if (state == AppLifecycleState.resumed) s.onResume();
  }

  void _toast(String msg) {
    if (!mounted) return;
    ScaffoldMessenger.of(context)
      ..hideCurrentSnackBar()
      ..showSnackBar(SnackBar(content: Text(msg), duration: const Duration(seconds: 2)));
  }

  Future<void> _openConnect() async {
    final cfg = await Navigator.of(context).push<ServerConfig>(MaterialPageRoute(builder: (_) => const ConnectPage()));
    if (cfg != null) await s.setConfig(cfg);
  }

  Future<void> _send() async {
    final text = _text.text;
    if (text.trim().isEmpty) return;
    try {
      await s.sendText(text);
      _text.clear();
      _toast('已发送，电脑上可以直接 Ctrl+V');
    } catch (e) {
      _toast('发送失败：$e');
    }
  }

  @override
  Widget build(BuildContext context) {
    return ListenableBuilder(
      listenable: s,
      builder: (context, _) => Scaffold(
        appBar: AppBar(
          title: const Text('FastCopy'),
          actions: [
            IconButton(tooltip: '连接电脑', icon: const Icon(Icons.qr_code_scanner), onPressed: _openConnect),
          ],
        ),
        body: s.config == null
            ? Center(child: FilledButton.icon(onPressed: _openConnect, icon: const Icon(Icons.qr_code_scanner), label: const Text('扫码连接电脑')))
            : RefreshIndicator(
                onRefresh: s.onResume,
                child: ListView(
                  padding: const EdgeInsets.fromLTRB(16, 8, 16, 32),
                  children: [
                    _statusCard(),
                    if (Platform.isAndroid && s.android != null) _androidCard(s.android!),
                    if (Platform.isIOS) _iosCard(),
                    const SizedBox(height: 12),
                    _composer(),
                    const SizedBox(height: 20),
                    Text('最近记录', style: Theme.of(context).textTheme.titleSmall),
                    const SizedBox(height: 8),
                    if (s.items.isEmpty) const Padding(padding: EdgeInsets.all(24), child: Center(child: Text('还没有内容'))),
                    for (final item in s.items.reversed) _itemTile(item),
                  ],
                ),
              ),
      ),
    );
  }

  Widget _statusCard() {
    final (color, label) = switch (s.connection) {
      Connection.connected => (Colors.green, '已连接 ${s.config!.host}'),
      Connection.connecting => (Colors.orange, '正在连接 ${s.config!.host}…'),
      Connection.disconnected => (Colors.red, '未连接：请确认电脑上的 FastCopy 在运行，且在同一 Wi-Fi'),
    };
    return Card(
      child: ListTile(
        leading: Icon(Icons.circle, color: color, size: 14),
        title: Text(label),
      ),
    );
  }

  Widget _androidCard(AndroidStatus a) {
    final theme = Theme.of(context);
    return Card(
      child: Padding(
        padding: const EdgeInsets.symmetric(vertical: 8),
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            SwitchListTile(
              title: const Text('后台自动同步'),
              subtitle: const Text('电脑上复制的文字会自动进入手机剪贴板，不用打开 App'),
              value: a.enabled,
              onChanged: (v) => s.setAndroidSync(v),
            ),
            if (a.enabled) ...[
              _check('通知权限（显示同步状态）', a.notifications, NativeBridge.requestNotifications),
              _check('不受电池优化限制（防止被系统杀掉）', a.batteryUnrestricted, NativeBridge.requestBatteryExemption),
              const Divider(),
              Padding(
                padding: const EdgeInsets.symmetric(horizontal: 16),
                child: Text(
                  a.autoSend
                      ? '手机 → 电脑：已开启全自动，手机上复制后电脑可直接粘贴'
                      : '手机 → 电脑：打开 App、点通知栏的「发送剪贴板到电脑」或下拉快捷开关「发送剪贴板」即可发送。想全自动，请完成下面两步：',
                  style: theme.textTheme.bodyMedium,
                ),
              ),
              if (!a.autoSend) ...[
                _check('允许显示在其他应用上层', a.overlay, NativeBridge.openOverlaySettings),
                ListTile(
                  leading: Icon(a.readLogs ? Icons.check_circle : Icons.radio_button_unchecked,
                      color: a.readLogs ? Colors.green : null),
                  title: const Text('用电脑执行一次 adb 授权'),
                  subtitle: SelectableText(a.adbCommand, style: const TextStyle(fontFamily: 'monospace', fontSize: 12)),
                  trailing: IconButton(
                    icon: const Icon(Icons.copy),
                    onPressed: () {
                      Clipboard.setData(ClipboardData(text: a.adbCommand));
                      _toast('命令已复制');
                    },
                  ),
                ),
                if (a.readLogs && a.overlay)
                  const Padding(padding: EdgeInsets.all(16), child: Text('授权完成后请关闭再打开「后台自动同步」')),
              ],
            ],
          ],
        ),
      ),
    );
  }

  Widget _check(String title, bool ok, Future<void> Function() fix) => ListTile(
        dense: true,
        leading: Icon(ok ? Icons.check_circle : Icons.error_outline, color: ok ? Colors.green : Colors.orange),
        title: Text(title),
        trailing: ok ? null : TextButton(onPressed: fix, child: const Text('去开启')),
      );

  Widget _iosCard() => const Card(
        child: ListTile(
          leading: Icon(Icons.info_outline),
          title: Text('打开 App 即自动同步'),
          subtitle: Text('iOS 不允许后台读写剪贴板。打开 FastCopy 时会自动：取回电脑上复制的文字，或把手机上新复制的文字发给电脑。\n'
              '建议在「设置 → FastCopy → 从其他 App 粘贴」选择「允许」，免去每次弹窗。'),
        ),
      );

  Widget _composer() => Card(
        child: Padding(
          padding: const EdgeInsets.all(12),
          child: Column(
            crossAxisAlignment: CrossAxisAlignment.end,
            children: [
              TextField(
                controller: _text,
                minLines: 2,
                maxLines: 6,
                decoration: const InputDecoration(hintText: '输入文字发送到电脑', border: InputBorder.none),
              ),
              FilledButton.icon(
                onPressed: s.connection == Connection.connected ? _send : null,
                icon: const Icon(Icons.send),
                label: const Text('发送'),
              ),
            ],
          ),
        ),
      );

  Widget _itemTile(Item item) {
    final time = TimeOfDay.fromDateTime(item.time).format(context);
    final subtitle = '${item.from} · $time';
    if (item.isText) {
      return Card(
        child: ListTile(
          title: Text(item.text ?? '', maxLines: 4, overflow: TextOverflow.ellipsis),
          subtitle: Text(subtitle),
          trailing: IconButton(
            tooltip: '复制',
            icon: const Icon(Icons.copy),
            onPressed: () async {
              await Clipboard.setData(ClipboardData(text: item.text ?? ''));
              await s.markSynced(item.text ?? ''); // don't send it straight back to the computer
              _toast('已复制');
            },
          ),
          onLongPress: () => s.delete(item),
        ),
      );
    }
    return Card(
      child: ListTile(
        leading: const Icon(Icons.insert_drive_file_outlined),
        title: Text(item.name ?? '文件', maxLines: 2, overflow: TextOverflow.ellipsis),
        subtitle: Text('$subtitle · ${_size(item.size ?? 0)}'),
        trailing: IconButton(
          tooltip: '下载',
          icon: const Icon(Icons.download),
          onPressed: () => launchUrl(s.api!.fileUri(item), mode: LaunchMode.externalApplication),
        ),
        onLongPress: () => s.delete(item),
      ),
    );
  }

  static String _size(int n) {
    const units = ['B', 'KB', 'MB', 'GB'];
    var v = n.toDouble();
    var i = 0;
    while (v >= 1024 && i < units.length - 1) {
      v /= 1024;
      i++;
    }
    return '${i == 0 ? v.toInt() : v.toStringAsFixed(1)} ${units[i]}';
  }
}
