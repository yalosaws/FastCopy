import 'package:flutter/material.dart';
import 'package:mobile_scanner/mobile_scanner.dart';

import 'api.dart';

/// Scan the QR code printed by `npm start` on the computer, or type the address.
class ConnectPage extends StatefulWidget {
  const ConnectPage({super.key});

  @override
  State<ConnectPage> createState() => _ConnectPageState();
}

class _ConnectPageState extends State<ConnectPage> {
  final _controller = MobileScannerController(formats: const [BarcodeFormat.qrCode]);
  final _manual = TextEditingController();
  bool _done = false;
  String? _error;

  void _accept(String raw) {
    if (_done) return;
    final cfg = ServerConfig.parse(raw);
    if (cfg == null) {
      setState(() => _error = '不是 FastCopy 地址：$raw');
      return;
    }
    _done = true;
    Navigator.of(context).pop(cfg);
  }

  @override
  void dispose() {
    _controller.dispose();
    _manual.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      appBar: AppBar(title: const Text('连接电脑')),
      body: ListView(
        padding: const EdgeInsets.all(16),
        children: [
          const Text('1. 在电脑上运行 FastCopy（npm start）\n2. 手机和电脑连同一个 Wi-Fi\n3. 扫描电脑终端里的二维码'),
          const SizedBox(height: 16),
          ClipRRect(
            borderRadius: BorderRadius.circular(16),
            child: AspectRatio(
              aspectRatio: 1,
              child: MobileScanner(
                controller: _controller,
                onDetect: (capture) {
                  for (final code in capture.barcodes) {
                    final v = code.rawValue;
                    if (v != null) return _accept(v);
                  }
                },
                errorBuilder: (context, error) => Center(
                  child: Padding(
                    padding: const EdgeInsets.all(24),
                    child: Text('无法打开相机：${error.errorCode.name}\n可以在下方手动输入地址', textAlign: TextAlign.center),
                  ),
                ),
              ),
            ),
          ),
          const SizedBox(height: 24),
          TextField(
            controller: _manual,
            keyboardType: TextInputType.url,
            autocorrect: false,
            decoration: InputDecoration(
              labelText: '或输入电脑上显示的地址',
              hintText: 'http://192.168.1.5:8080/?token=…',
              errorText: _error,
              border: const OutlineInputBorder(),
            ),
            onSubmitted: _accept,
          ),
          const SizedBox(height: 12),
          FilledButton(onPressed: () => _accept(_manual.text), child: const Text('连接')),
        ],
      ),
    );
  }
}
