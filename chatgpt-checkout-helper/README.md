# ChatGPT Checkout Helper (Local)

一个仅在本地浏览器中运行的 Chrome/Edge Manifest V3 扩展，为 ChatGPT Plus 结账请求提供确认 UI。

## 功能

- 仅注入 `https://chatgpt.com/*`
- 显示当前计划、地区、币种和活动参数
- 检测 ChatGPT 登录状态
- 要求确认账单地区和活动资格后才能继续
- 防止重复点击和重复创建结账会话
- 处理超时、非 JSON 响应和 HTTP 错误
- 不保存、打印或传输 access token 到第三方

## 安装

### Chrome

1. 打开 `chrome://extensions/`。
2. 开启右上角的“开发者模式”。
3. 点击“加载已解压的扩展程序”。
4. 选择本项目目录 `chatgpt-checkout-helper`。

### Edge

1. 打开 `edge://extensions/`。
2. 开启“开发人员模式”。
3. 点击“加载解压缩的扩展”。
4. 选择本项目目录 `chatgpt-checkout-helper`。

安装后打开或刷新 `https://chatgpt.com/`，页面右下角会出现“Plus 结账”按钮。

## 注意事项

该扩展调用的是 ChatGPT 网页使用的未公开内部接口，不属于 OpenAI 公共 API，可能随时发生变化或失效。

当前参数沿用原始脚本：

- 账单地区：`PH`
- 币种：`PHP`
- 活动：`plus-1-month-free`

只有在账单地区信息真实且明确符合活动资格时才应继续。优惠、税费、续费价格和最终资格均以官方结账页显示为准。如果结账页没有显示预期优惠，请勿付款。

## 本地验证

需要 Node.js 18 或更高版本：

```powershell
node --check core.js
node --check content.js
node --test tests/core.test.cjs
```
