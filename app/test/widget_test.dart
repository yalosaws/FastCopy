import 'package:fastcopy/api.dart';
import 'package:fastcopy/clipboard_sync.dart';
import 'package:flutter_test/flutter_test.dart';

class FakeHost implements SyncHost {
  String? clipboard;
  final sent = <String>[];
  @override
  String? lastSynced;
  @override
  String? lastSeenId;

  @override
  Future<String?> readClipboard() async => clipboard;
  @override
  Future<void> writeClipboard(String text) async => clipboard = text;
  @override
  Future<void> send(String text) async => sent.add(text);
}

Item text(String id, String t, {String? client, String from = '电脑剪贴板'}) =>
    Item(id: id, type: 'text', text: t, from: from, client: client, time: DateTime(2026));

void main() {
  group('ServerConfig.parse', () {
    test('parses the address printed by the server', () {
      final c = ServerConfig.parse('http://192.168.1.5:8080/?token=abc123')!;
      expect(c.baseUrl, 'http://192.168.1.5:8080');
      expect(c.token, 'abc123');
      expect(c.uri('/api/latest').toString(), 'http://192.168.1.5:8080/api/latest?token=abc123');
    });
    test('scheme is optional', () {
      expect(ServerConfig.parse(' 10.0.0.2:9000/?token=x ')!.baseUrl, 'http://10.0.0.2:9000');
    });
    test('rejects other QR codes', () {
      expect(ServerConfig.parse('https://example.com/'), isNull);
      expect(ServerConfig.parse('hello'), isNull);
      expect(ServerConfig.parse(''), isNull);
    });
  });

  test('SseParser handles events, multi-line data and pings', () {
    final p = SseParser();
    final out = <SseEvent>[];
    for (final l in [': ping', '', 'event: add', 'data: {"a":1}', '', 'data: line1', 'data: line2', '']) {
      final e = p.add(l);
      if (e != null) out.add(e);
    }
    expect(out.map((e) => e.event), ['add', 'message']);
    expect(out[0].data, '{"a":1}');
    expect(out[1].data, 'line1\nline2');
  });

  group('ClipboardSync', () {
    late FakeHost host;
    late ClipboardSync sync;
    setUp(() {
      host = FakeHost();
      sync = ClipboardSync(host, 'me');
    });

    test('first launch changes nothing on either side', () async {
      host.clipboard = 'already on phone';
      expect(await sync.onResume([text('1', 'from pc')]), isNull);
      expect(host.sent, isEmpty);
      expect(host.clipboard, 'already on phone');
    });

    test('text copied on the computer is applied on resume', () async {
      host.clipboard = 'old';
      await sync.onResume([text('1', 'a')]);
      await sync.onResume([text('1', 'a'), text('2', 'copied on pc')]);
      expect(host.clipboard, 'copied on pc');
      expect(host.sent, isEmpty);
      // Resuming again doesn't send it back.
      await sync.onResume([text('1', 'a'), text('2', 'copied on pc')]);
      expect(host.sent, isEmpty);
    });

    test('text newly copied on the phone is sent on resume and wins', () async {
      host.clipboard = 'old';
      await sync.onResume([]);
      host.clipboard = 'copied on phone';
      await sync.onResume([text('2', 'copied on pc')]);
      expect(host.sent, ['copied on phone']);
      expect(host.clipboard, 'copied on phone');
    });

    test('live items: applies other devices, ignores own', () async {
      expect(await sync.onItem(text('3', 'mine', client: 'me')), isFalse);
      expect(await sync.onItem(text('4', 'theirs')), isTrue);
      expect(host.clipboard, 'theirs');
      expect(host.lastSynced, 'theirs');
    });
  });
}
