import 'dart:async';
import 'dart:convert';

import 'package:http/http.dart' as http;

/// Where the computer's FastCopy server lives, parsed from the QR code / address it prints.
class ServerConfig {
  final String baseUrl; // e.g. http://192.168.1.5:8080
  final String token;

  const ServerConfig(this.baseUrl, this.token);

  /// Accepts what the computer prints, e.g. `http://192.168.1.5:8080/?token=abc`
  /// (the scheme may be omitted). Returns null if it doesn't look like a FastCopy address.
  static ServerConfig? parse(String input) {
    var s = input.trim();
    if (s.isEmpty) return null;
    if (!s.contains('://')) s = 'http://$s';
    final uri = Uri.tryParse(s);
    if (uri == null || uri.host.isEmpty || !(uri.scheme == 'http' || uri.scheme == 'https')) return null;
    final token = uri.queryParameters['token'];
    if (token == null || token.isEmpty) return null;
    final port = uri.hasPort ? ':${uri.port}' : '';
    return ServerConfig('${uri.scheme}://${uri.host}$port', token);
  }

  String get host => Uri.parse(baseUrl).host;

  Uri uri(String path, [Map<String, String> query = const {}]) =>
      Uri.parse('$baseUrl$path').replace(queryParameters: {'token': token, ...query});

  Map<String, dynamic> toJson() => {'baseUrl': baseUrl, 'token': token};

  static ServerConfig fromJson(Map<String, dynamic> j) => ServerConfig(j['baseUrl'] as String, j['token'] as String);
}

class Item {
  final String id;
  final String type; // 'text' | 'file'
  final String? text;
  final String? name;
  final int? size;
  final String from;
  final String? client;
  final DateTime time;

  Item({
    required this.id,
    required this.type,
    this.text,
    this.name,
    this.size,
    required this.from,
    this.client,
    required this.time,
  });

  bool get isText => type == 'text';

  factory Item.fromJson(Map<String, dynamic> j) => Item(
        id: j['id'] as String,
        type: j['type'] as String,
        text: j['text'] as String?,
        name: j['name'] as String?,
        size: (j['size'] as num?)?.toInt(),
        from: (j['from'] as String?) ?? '',
        client: j['client'] as String?,
        time: DateTime.fromMillisecondsSinceEpoch((j['time'] as num).toInt()),
      );
}

class SseEvent {
  final String event;
  final String data;
  SseEvent(this.event, this.data);
}

/// Turns a stream of SSE lines into events.
class SseParser {
  String _event = 'message';
  final _data = <String>[];

  /// Feeds one line; returns a complete event when [line] ends one.
  SseEvent? add(String line) {
    if (line.isEmpty) {
      if (_data.isEmpty) return null;
      final e = SseEvent(_event, _data.join('\n'));
      _event = 'message';
      _data.clear();
      return e;
    }
    if (line.startsWith(':')) return null;
    if (line.startsWith('event:')) {
      _event = line.substring(6).trim();
    } else if (line.startsWith('data:')) {
      var d = line.substring(5);
      if (d.startsWith(' ')) d = d.substring(1);
      _data.add(d);
    }
    return null;
  }
}

class FastCopyApi {
  final ServerConfig config;
  final String clientId;
  final String deviceName;
  final http.Client _http;

  FastCopyApi(this.config, {required this.clientId, required this.deviceName, http.Client? client})
      : _http = client ?? http.Client();

  Map<String, String> get _identity => {
        'X-FastCopy-Client': clientId,
        'X-FastCopy-Device': Uri.encodeComponent(deviceName),
      };

  Future<Item> sendText(String text) async {
    final res = await _http
        .post(config.uri('/api/text'),
            headers: {..._identity, 'Content-Type': 'text/plain; charset=utf-8'}, body: utf8.encode(text))
        .timeout(const Duration(seconds: 10));
    if (res.statusCode != 201) throw Exception('HTTP ${res.statusCode}');
    return Item.fromJson(jsonDecode(utf8.decode(res.bodyBytes)) as Map<String, dynamic>);
  }

  Future<List<Item>> items() async {
    final res = await _http.get(config.uri('/api/items')).timeout(const Duration(seconds: 10));
    if (res.statusCode != 200) throw Exception('HTTP ${res.statusCode}');
    return (jsonDecode(utf8.decode(res.bodyBytes)) as List).map((e) => Item.fromJson(e as Map<String, dynamic>)).toList();
  }

  Future<void> delete(String id) => _http.delete(config.uri('/api/items/$id'));

  Uri fileUri(Item item) => config.uri('/files/${item.id}');

  /// Live events from the server; the stream ends (or errors) when the connection drops.
  Stream<SseEvent> events() async* {
    final req = http.Request('GET', config.uri('/events'))..headers.addAll({'Accept': 'text/event-stream', ..._identity});
    final res = await _http.send(req).timeout(const Duration(seconds: 10));
    if (res.statusCode != 200) throw Exception('HTTP ${res.statusCode}');
    final parser = SseParser();
    // Server pings every 25s; treat a long silence as a dead connection.
    final lines = res.stream
        .transform(utf8.decoder)
        .transform(const LineSplitter())
        .timeout(const Duration(seconds: 60));
    await for (final line in lines) {
      final e = parser.add(line);
      if (e != null) yield e;
    }
  }

  void close() => _http.close();
}
