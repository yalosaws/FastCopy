# FastCopy 手机 App

FastCopy 的安卓 / iOS 客户端，使用说明见[仓库根目录 README](../README.md#手机-app完全自动同步)。

代码结构：

```
lib/api.dart              # 服务器地址解析、HTTP / SSE 客户端
lib/clipboard_sync.dart   # 前台剪贴板同步规则（iOS 使用）
lib/app_state.dart        # 连接、记录列表、同步状态
lib/main.dart             # 主界面
lib/connect_page.dart     # 扫码 / 手动输入地址
lib/native_bridge.dart    # 与安卓原生后台服务通信
android/app/src/main/kotlin/com/fastcopy/fastcopy/
  SyncService.kt          # 前台服务：保持连接，把电脑复制的文字写入手机剪贴板
  Sync.kt                 # 配置、HTTP / SSE、剪贴板读写
  Helpers.kt              # 透明读取页、快捷开关、开机自启、日志监听
  MainActivity.kt         # Flutter 方法通道
```
