# Plus Extractor Local Chain Relay

该中继解决供应商网关限制中国大陆出口时的连接超时：

```text
Chrome 扩展
  → 127.0.0.1:17897
  → Mihomo/Clash Verge 127.0.0.1:7897
  → 动态住宅代理网关
  → ChatGPT
```

## 安装并启动

```powershell
powershell.exe -NoProfile -ExecutionPolicy Bypass -File .\relay\install-relay.ps1
```

安装脚本会立即启动中继，并在当前用户的“启动”文件夹写入隐藏启动器。中继仅监听 `127.0.0.1`：

- HTTP CONNECT 代理：`127.0.0.1:17897`
- 插件控制接口：`127.0.0.1:17898`
- 第一跳 Mihomo：`127.0.0.1:7897`

代理池凭据由扩展在切换阶段发送到本机控制接口，只保存在中继进程内存中；日志位于 `%LOCALAPPDATA%\PlusExtractorRelay`，只记录阶段、目标与脱敏网关。

## 停止

```powershell
powershell.exe -NoProfile -ExecutionPolicy Bypass -File .\relay\stop-relay.ps1
```

## 卸载自动启动

```powershell
powershell.exe -NoProfile -ExecutionPolicy Bypass -File .\relay\uninstall-relay.ps1
```
