# qoder-proxy

将 Qoder CLI 的模型能力通过 OpenAI 兼容的 HTTP API 暴露给本地程序调用。

## 前置条件

运行环境：Windows 与 Ubuntu/Linux 均可（Node.js ≥ 18）。

确保 `qodercli` 已安装并登录：

```bash
qodercli login
```

> 服务会自动探测 `qodercli` 位置：Windows 查找 `~/.qoder/bin/qodercli/qodercli.exe` 等，Linux 查找 `~/.qoder/bin/qodercli/qodercli`、`/usr/local/bin/qodercli`、`/usr/bin/qodercli` 等，最后回退到 PATH 上的 `qodercli`。若自动探测失败，可用 `QODER_CLI_PATH` 指定绝对路径。

## 安装与启动

```bash
npm install
npm start
```

默认监听 `http://127.0.0.1:8787`，可通过环境变量配置：

| 变量 | 默认值 | 说明 |
|------|--------|------|
| `PORT` | `8787` | 监听端口 |
| `HOST` | `127.0.0.1` | 监听地址 |
| `QODER_CLI_PATH` | 自动检测 | qodercli 可执行文件路径 |

## API

### GET /v1/models

列出可用模型。

```bash
curl http://127.0.0.1:8787/v1/models
```

### POST /v1/chat/completions

调用模型，支持流式（`"stream": true`）和非流式。

```bash
# 非流式
curl http://127.0.0.1:8787/v1/chat/completions \
  -H "Content-Type: application/json" \
  -d '{
    "model": "claude-sonnet-4-5",
    "messages": [{"role": "user", "content": "你好"}]
  }'

# 流式
curl http://127.0.0.1:8787/v1/chat/completions \
  -H "Content-Type: application/json" \
  -d '{
    "model": "claude-sonnet-4-5",
    "stream": true,
    "messages": [{"role": "user", "content": "你好"}]
  }'
```

### GET /v1/quota

查看账户额度/状态，返回 JSON。

```bash
curl http://127.0.0.1:8787/v1/quota
```

```json
{
  "logged_in": true,
  "version": "1.1.69",
  "username": "...",
  "email": "...",
  "user_type": "personal_standard"
}
```

### GET /health

健康检查，返回当前使用的 CLI 路径。

## 在其他程序中使用

任何支持 OpenAI API 的客户端均可直接对接，只需将 `base_url` 指向本服务：

```python
from openai import OpenAI

client = OpenAI(base_url="http://127.0.0.1:8787/v1", api_key="not-needed")
resp = client.chat.completions.create(
    model="claude-sonnet-4-5",
    messages=[{"role": "user", "content": "你好"}],
)
print(resp.choices[0].message.content)
```
