# qoder-proxy

将 Qoder / Qoder CN 的模型能力通过 OpenAI 兼容的 HTTP API 暴露给本地程序调用，**支持多账号池**：

- **`/v1`（主接口）**：纯 HTTP 直连 Qoder 推理端点，自带设备码 OAuth 登录，无进程 spawn 开销，支持 system prompt / tool calls / 原生流式；一次进程可同时登录多个账号、同时挂国际版与中国版；
- **`/v2`**：`/v1` 的兼容别名，同一套路由；
- **`/v0`（已默认隐藏）**：早期的 `qodercli` 子进程转发通道，每请求起进程、延迟高，代码保留，设 `QODER_ENABLE_CLI=1` 可临时恢复。

## 两条产品线到底有没有差异

结论：**协议完全同构，差异只是一组配置值 + 一个只在国际版存在的端点**（对照 `dsh-our-free-model` 的逆向结果，并在本机重新实测）。

| 项 | qoder（国际版） | qodercn（中国版） |
|---|---|---|
| 授权页 | `qoder.com` | `qoder.cn` |
| 令牌接口（poll/refresh/userinfo） | `openapi.qoder.sh` | `openapi.qoder.com.cn` |
| client_id | `e883ade2-…` | `732aef47-…`（test 与 prod 同值） |
| `session_type` | `qodercli` | `qoder_work` |
| 公开推理端点 | `api2-v2.qoder.sh` 存在（实测 401） | **不存在**（实测 404，dsh 早前记为 503） |
| 加密推理端点 | `api2.qoder.sh`（实测可达） | `gateway.qoder.com.cn`（实测可达） |
| 模型目录 | 17 条（独有 ultimate / performance / efficient / smodel / cmodel） | 14 条（独有 q37fmodel / gm51model，mmodel 为 MiniMax-M2.7 且仅 200K 上下文） |

登录、轮询、续期、请求体的处理逻辑两边完全共用，只在 `src/products.js` 里按产品线取不同值。真正的分水岭是**推理端点有两套**：

| 路由 | 认证方式 | 认的模型名 | 说明 |
|---|---|---|---|
| 公开 `{apiBase}/model/v1/chat/completions` | `Bearer <设备令牌>`，标准 OpenAI | 通用名（`qwen-flash` 等） | 目录 key 一律回 `Unsupported model`；仅国际版有 |
| 加密 `{encryptedApiBase}/algo/api/v2/service/pro/sse/agent_chat_generation?…&Encode=1` | WASM 签名的 `Bearer COSY.<载荷>.<签名>` | 目录 key（`qfmodel`、`dmodel`…） | 客户端真实链路，解锁全量目录模型；中国版只有这条路 |

加密链路的三个硬性要求（都踩过坑，写在代码注释里）：请求头必须原样透传（改成普通 Bearer 会 403 Signature invalid）、请求体必须带 `business:{type:'agent'}`（缺了会被路由到故障节点并报 `[FAIL]node:...`）、账号必须有 `uid`（缺了签名无效报 101）。响应是「每帧再套一层信封」的 SSE，本服务负责剥信封，内层就是标准 OpenAI 帧。

## 前置条件

运行环境：Windows 与 Ubuntu/Linux 均可（Node.js ≥ 18）。

`/v1` 不依赖 `qodercli`，只需独立完成设备码登录（见下文）。本机 `~/.qoder/.auth` 里 CLI 的凭据是加密存储的，代理无法复用。要走目录模型（`qfmodel` 等）或中国版推理，需要 `vendor/qoder-auth-wasm.wasm` 就位（本仓库已内置）。

> 仅当重新启用 `/v0` 时，才需要安装并登录 `qodercli`（`qodercli login`）：服务会自动探测其位置，探测失败可用 `QODER_CLI_PATH` 指定绝对路径。

## 安装与启动

```bash
pnpm install
pnpm run check      # 看账号池状态，未登录会给出对应命令
pnpm start          # 启完后浏览器打开 http://127.0.0.1:8787/ 就是演示聊天台
pnpm run dev        # 开发模式：走 8788，改代码自动重启（scripts/dev.js + node --watch）
pnpm run clear      # 清掉账号池里存的所有令牌（要输 clear 确认）
```

`pnpm run dev` 与 `pnpm start` 端口错开，所以可以一边跑着正式实例一边开发；要换默认开发端口给 `QODER_DEV_PORT` 就行（`PORT` 优先级更高）。注意 `--watch` 要 Node 18.11+，且它只看已加载的 `.js` 模块：改 `public/index.html` 不用重启，服务按 mtime 重读，刷新浏览器即可。

默认监听 `http://127.0.0.1:8787`：

| 变量 | 默认值 | 说明 |
|------|--------|------|
| `PORT` | `8787`（`pnpm run dev` 为 `8788`） | 监听端口 |
| `HOST` | `127.0.0.1` | 监听地址 |
| `QODER_ENABLE_CLI` | 未设置 | 设为 `1` 时重新开放已隐藏的 `/v0` CLI 通道 |
| `QODER_CLI_PATH` | 自动检测 | qodercli 可执行文件路径（仅 /v0） |

账号池与路由相关：

| 变量 | 默认值 | 说明 |
|------|--------|------|
| `QODER_PROXY_ACCOUNTS_FILE` | `~/.qoder-proxy/accounts.json` | 多账号凭据池（Linux/macOS 下 0600） |
| `QODER_PRODUCT` | `qoder` | 裸模型名缺省偏好的产品线；也决定 env 令牌归属哪个产品 |
| `QODER_ACCESS_TOKEN` | 无 | 手工指定令牌，以只读账号 `env` 的形式加入池（不可续期、不落盘） |
| `QODER_V2_MODELS` | `qwen-flash,qwen-plus` | 公开端点可用的通用模型名（仅国际版） |
| `QODER_AUTH_BASE` / `QODER_OPENAPI_BASE` / `QODER_API_BASE` / `QODER_ENCRYPTED_API_BASE` / `QODER_CLIENT_ID` | 见上表 | 覆盖当前产品线（`QODER_PRODUCT`）的端点与 client_id |
| `QODER_PROXY_CRED_FILE` | `~/.qoder-proxy/credentials.json` | 旧版单账号凭据位置，首次加载会自动迁移进池 |

## 演示页面（GET /）

服务起来后直接用浏览器打开 `http://127.0.0.1:8787/` 就是一个控制台（`src/playground.js` 只负责读文件与响应，页面本体在 `public/index.html`）：左侧固定导航 + 四个独立页面，用 hash 路由切换（`#/chat` 聊天演示、`#/accounts` 账号和模型、`#/docs` 接入文档、`#/deploy` 部署文档）：

- **聊天演示**：聊天式布局：模型在左、我在右、错误居中，气泡带角色头像与入场动画；代码块自带语言标签与悬停“复制”；首次打开的空会话会给几个可直接点的一句话例子；顶部状态牌直接拉 `/v1/models` 与 `/health`，列出每个账号有多少个模型；没登录时页面会提示去「账号和模型」页或跑 `pnpm run login`；
- **账号和模型**：左列账号池（别名 / 产品线 / 昵称 / 到期 / 排队状态 / 已勾了几个模型），点一个账号就在右列展开它的全部模型，默认全部勾选；取消勾选是服务边界而不是界面灰显——该模型不再出现在 `GET /v1/models`，指到它名下的请求回 404，裸模型名会自动落到仍然供它的下一个账号，勾选结果落在 `accounts.json` 的 `models_disabled` 里（拒绝列表，所以以后目录新增模型默认就是勾选态），改完刷新聊天页下拉立即同步；env 注入的只读账号只能看不能改；非只读账号可点「移除」（`DELETE /v1/accounts/:alias`）；加账号仍然是一键设备码授权：点「添加国际版账号 / 添加中国版账号」会发起设备码授权（`POST /v1/auth/login`）、打开授权页并每 2 秒轮询 `/v1/auth/status`，登录成功后自动刷新模型列表；
- **接入文档**（原「外部接入」弹窗，改为独立页面）：直接把本机地址（`location.origin`）填进 curl / Python / Node 的示例里，并附一张 OpenAI 兼容客户端（LobeChat / ChatWise / Open WebUI / Jan 等）的接入说明；
- **部署文档**：从本地起服务、pm2 后台常驻、局域网共享（`HOST=0.0.0.0`）、Nginx 反代上公网（对应仓库 `vhost.conf`，含上公网前加访问控制的提醒）、环境变量速查表与部署后自检命令；
- 聊天页只留一个模型选择框，就在输入框正上方（跟流式开关同一行），不再另外做一级“常用模型”去重下拉：联想下拉逐条列出 `/v1/models` 的全部条目，也就是**每个账号的每个模型各一条**——两个国际版账号就会各出一组，label 形如 `Qwen3.8-Flash（国际版 · a1 · 128K）`，带别名、产品线、上下文窗口、公开端点/免费标记；选中就是完整的 `ModelName-product_name@alias`，账号与推理渠道由服务映射（取消勾选的条目不在此列，也不会被接受）；
- 演示页只发最小请求体（模型 + 历史 + 流式开关），系统提示词、temperature、max_tokens 这类参数一律走上游默认（接口本身照旧支持，外部客户端照常可传）；
- 流式走 `fetch` + `ReadableStream` 直接读 SSE，包括排队帧（只有 `message` + `code`）与错误帧；中断时已输出的内容会留在会话里（下一轮历史需要它），并提供“重试这一条”；
- 每条回复下方显示实际命中的模型 id、耗时与 token 用量，可一键复制；会话存在 localStorage，刷新不丢；
- 零依赖：不引 CDN、不引框架、只请求相对路径，所以内网、改端口、反代都能用；模型输出一律先转义再上屏（实测上游真会返回字面 HTML 标签，这里只会当文本显示）。

想改样式或加功能就直接编 `public/index.html`：服务按文件 mtime 重新读取，刷新页面就生效，不用重启。

## 多账号登录与模型命名

**登录次数不限，两个产品线可以混着登。** 不带参数时是一个键盘菜单（↑/↓ 移动、回车确认选中那行、Ctrl+C 或 q 退出），每次只登一条线，每条线后面直接列出已登了几个、别名是什么：

```
选择要登录的产品线（当前账号池：a1）

❯ Qoder          已登录 1 个：a1(Chip Tong)
  Qoder (中国版)  尚未登录
↑/↓ 选择，回车 确认，Ctrl+C 退出
```

一次只登一条产品线；要登另一条，跑完这一次再跑一次就是（两道授权互不干扰，不会因先登国际版而卡住）。命令行方式全保留：

```bash
pnpm run login                        # 键盘菜单
pnpm run login -- --product qodercn   # 跳过菜单直接登中国版（cn / "Qoder CN" 同义）
pnpm run login -- --no-browser        # 无头/远程机器，只打印链接
pnpm run login -- --list              # 只看账号池：别名/产品/昵称/uid/到期时间
```

`--product` 只接一个产品线，写 `both` 或 `qoder,qodercn` 会被拒并提醒你再跑一次。非交互环境（管道、CI、无 TTY、`TERM=dumb`）自动退回成输入 1/2 的文字菜单；要是你的终端把转义序列渲染成一堆乱码，用 `QODER_LOGIN_MENU=numeric` 强制走文字菜单（`arrow` 则反向强制）。`QODER_PRODUCT` 环境变量改的是无 TTY 时的默认产品线。

**反过来，`pnpm run clear` 是清令牌**：

```bash
pnpm run clear                 # 交互确认（输入 clear）后清掉全部账号的令牌
pnpm run clear -- --list       # 先看会清掉哪些：别名/产品/昵称/uid/到期时间
pnpm run clear -- --product cn # 只清一条产品线，另一条留着
pnpm run clear -- --yes        # 不询问，脚本/CI 用
pnpm run clear -- --legacy     # 连老版本留下的 credentials.json(.migrated) 一起删
```

清的是本机文件里的令牌：远端授权不会因此失效（真要撤销得到 Qoder 账号页操作）；正在跑的服务按请求读池子，清完立刻生效，之后调用一律 401，直到重新登录。非交互环境不带 `--yes` 时它只会拒绝并提示加参数，不会自己动手。排队冷却跟着条目一起被清掉；`QODER_ACCESS_TOKEN` 注入的那个只读条目不在文件里，得改环境变量本身。

**重复登录同一个账号就是覆盖，不会多出条目。** 别名由产品线字母 + 序号组成（国际版 `a1`、`a2`…，中国版 `c1`、`c2`…）。池里的条目按「产品线 + uid」定位：同一个人在同一条产品线上再登一次，只刷新令牌，**别名保持不变**（已配好的客户端不用改名）、昵称与排队冷却一并保留；换了另一个人登，才会多出一个别名（`a2`、`c2`…）。同一个人分别登两条线则是两条独立条目（两套端点、两套目录）。只想续期不用重登：`POST /v1/accounts/<别名>/refresh`。

登录写进 `~/.qoder-proxy/accounts.json`，正在运行的服务按请求实时读取，不用重启。这份文件是令牌唯一的存放处，所以丢掉一条登录就没法再找回来：服务本身不会把它写空——只有三条路允许把池子清成空（`/v1/auth/logout`、`pnpm run clear`、删掉最后一个账号），其它任何一次「空列表落盘」都会被拒绝并打日志。

**取号方式就藏在模型名里**（这样任何 OpenAI 客户端都能用，不需要自定义 header）：标志就是 `ModelName-product_name@nickname`，也就是 `GET /v1/models` 列出的那一行，选中后账号与推理渠道都由代理映射，而发到 Qoder 的仍然是它自己的目录短名：

| 写法 | 含义 |
|---|---|
| `Qwen3.8-Flash-qoder@a1` | 国际版账号 a1 跑 Qwen3.8-Flash（走加密端点，上游收到 `qfmodel`） |
| `GLM-5.2-qodercn@c1` | 中国版账号 c1 跑 GLM-5.2（上游收到 `gm51model`） |
| `qwen-flash-qoder@a1` | 国际版公开端点的通用名（本来就走公开端点，不做映射） |
| `Qwen3.8-Flash-qodercn` | 只写产品线不写账号：在这条线的启用账号里自动选号 |
| `Qwen3.8-Flash` / `Qwen3.8-Flash@a1` | 只写模型名（可带账号）：按账号顺序找第一个认识它、且不在排队期的账号 |
| `qfmodel` / `qfmodel@a1` / `qfmodel-qodercn` | Qoder 的目录短名，与真实名完全等价（存量配置不用改） |

三段都可省略、也可混用，但**一个模型只列一次**：`/v1/models` 的条目数就是「账号 × 模型」（两个账号登满时：国际版 17 + 2 个通用名 + 中国版 14 = 33 行），不再有额外的裸名清单。

名字比对只看字母和数字，所以 `GLM-5.2`、`glm 5.2`、`GLM52` 命中同一条目；`-qoder` / `-qodercn` 结尾才算产品线段（模型名自带的连字符不受影响，`GLM-5.3-Flash` 还是完整一个名字）；`@` 后面先按别名精确匹配，匹不上再按账号昵称匹配。两种写法共用同一份排队冷却（冷却记在短名上），不会出现“换种写法就绕过限流”。

同一条请求里，403/429/402（公开端点的额度耗尽）或流内排队帧（`code` 为 10605/110/429）会给对应账号的那一个模型记 30 秒冷却期，没写 `@别名` 的请求随即落到下一个账号；显式 `@别名` 不换号，直接把错误原样回给你。冷却只针对具体模型，某账号在公开端点没额度不会影响它跑加密端点的目录模型。

## API（/v1，直连 HTTP，主接口）

### 登录

```bash
curl -X POST http://127.0.0.1:8787/v1/auth/login                     # 国际版，打开浏览器
curl -X POST http://127.0.0.1:8787/v1/auth/login \
  -H "Content-Type: application/json" -d '{"product":"qodercn","open":false}'
curl http://127.0.0.1:8787/v1/auth/status        # 账号池 + 正在等待授权的流程
curl -X POST http://127.0.0.1:8787/v1/auth/logout \
  -H "Content-Type: application/json" -d '{"alias":"c1"}'   # 只删一个；不带 alias 清空
```

命令行侧的对应命令是 `pnpm run clear`（可交互确认、可 `--product` 只清一条线）。

走 HTTP 登录与命令行同一套覆盖规则（同产品线 + 同 uid 覆盖原条目、别名不变）；两条产品线各自一个待授权流程，互不干扰。

### 账号池管理

```bash
curl http://127.0.0.1:8787/v1/accounts                    # 别名/产品/昵称/过期时间/排队中的模型
curl -X PATCH http://127.0.0.1:8787/v1/accounts/c1 \
  -H "Content-Type: application/json" -d '{"enabled":false}'   # 暂时停用，或改 alias
curl -X DELETE http://127.0.0.1:8787/v1/accounts/c1            # 忘记这个登录
curl -X POST http://127.0.0.1:8787/v1/accounts/a1/refresh       # 手动静默续期
curl -X POST http://127.0.0.1:8787/v1/accounts/a1/clear-limit   # 清掉记录的排队冷却
curl http://127.0.0.1:8787/v1/accounts/a1/models               # 这个账号的完整模型目录（含未勾选行，带 enabled 标记）
curl -X PUT http://127.0.0.1:8787/v1/accounts/a1/models \
  -H "Content-Type: application/json" -d '{"models_disabled":["qfmodel"]}'   # 整组替换：发未勾选的短名，空数组 = 全部勾选
```

所有出口都不含 token 与 machine_id。

### GET /v1/models

就是「账号 × 模型」的逐行清单：每条 id 形如 `Qwen3.8-Flash-qoder@a1`，一个模型在一个账号上只出现一次，没有裸名条目（国际版账号会多出公开端点的通用名）。条目附带 `model_key`（Qoder 短名，同样可以作为 `model` 传入）、`display_name`、`account_nickname`、`product`、`context_window`、`free`、`price_factor`、`efforts` 等目录信息，可直接喂给选择界面。被在「账号和模型」页取消勾选的条目不会出现在这里，也不接受请求。

### POST /v1/chat/completions

OpenAI 兼容。`model` 同时决定账号与上游路由：目录模型（写真实名或短名都行，可带产品线与账号后缀）走 WASM 签名的加密端点，公开端点的通用名走普通 HTTP。代理在发上游前把真实名换成目录短名，两条路都不会把显示名泄给 Qoder。

```bash
curl http://127.0.0.1:8787/v1/chat/completions \
  -H "Content-Type: application/json" \
  -d '{
    "model": "Qwen3.8-Flash-qoder@a1",
    "stream": true,
    "messages": [{"role": "user", "content": "你好"}]
  }'
```

行为要点：

- `stream:true` 得到标准 SSE，且无论上游是否正常收尾，流一定以 `data: [DONE]` 结束（上游吞掉终止帧或中途中断时由本服务补齐，客户端不会挂在半开连接上）；加密端点本身只出流，`stream` 省略时由本服务把帧聚合回一条 `chat.completion`（含 `tool_calls` 增量合并与 `usage`）；
- 上游业务错误帧的 `code` 字段与 `message` 原文**保真转发**，排队/额度判断不会被降级成普通 500；心跳帧丢弃，避免 `data: null` 打挂下游；
- `tools` / `tool_calls` / `tool_call_id` 完整透传（丢掉其中任一个，模型就会改用正文 XML 臆造调用）；`reasoning_effort` 仅当目录允许关闭时才映射为 `none`；`temperature`/`top_p` 这类采样参数加密协议里没有对应字段，不透传；
- access token 过期自动续期，401 强制续期重试一次，续期按账号去重，并发请求不会把 refresh_token 打爆。

> `/v2/...` 是同一套接口的别名，存量调用无需改造。

### GET /health

健康检查，返回主接口与 CLI 通道状态。

## 自检

```bash
pnpm run selftest
```

离线回归，不联网也不碰真实 `~/.qoder-proxy`：覆盖双产品预设、账号池增删改与限流冷却、裸名/后缀名路由与错误码、信封剥包（心跳丢弃、错误分类、`code` 保真、非流式聚合）、OpenAI 请求到加密 ask 的字段映射，以及用内置 WASM 真签一个请求（校验 URL、`Bearer COSY.` 头与密文请求体）。

两个单次排查脚本（假凭据，不消耗额度）：

```bash
node scripts/probe-wasm.js    # 离线：WASM 签名桥在本机 Node 版本下能否真签
node scripts/probe-infer.js   # 联网：两个加密主机是否可达（回结构化错误就算通）
```

`pnpm run check` 则检查本机真实状态：账号池里有哪些账号、令牌是否过期/可续期、`uid` 是否齐全（缺 `uid` 时目录模型必然签名失败）、WASM 资产在不在，以及重新启用时的 CLI 通道。

```bash
pnpm run live                      # 按账号池自动组一批用例
pnpm run live -- GLM-5.2-qodercn@c1   # 只跑指定模型（非流式 + 流式各一次，短名也可）
```

`pnpm run live` 会自己拉起服务、拿池里真实的登录态打上游接口，因此**会消耗额度**，不属于自检流程，只在你主动验收时跑。它重点看三条链路是否真的通：加密端点的非流式聚合、流式能否正常收到 `data: [DONE]` 收尾、以及没写别名的名字在公开端点额度耗尽时能否落到下一个账号。

## API（/v0，CLI 进程通道，已默认隐藏）

因每请求 spawn 子进程、延迟高，`/v0` 已从默认路由中隐藏（访问返回 404 + `transport_disabled`）。代码保留，设 `QODER_ENABLE_CLI=1` 重启后恢复：`GET /v0/models`（来自 `qodercli --list-models`）、`POST /v0/chat/completions`（messages 拍平成纯文本，不支持 tool calls）、`GET /v0/quota`（`qodercli status -o json`）。

## 在其他程序中使用

任何支持 OpenAI API 的客户端均可直接对接，把 `base_url` 指向 `/v1`，用模型名选账号：

```python
from openai import OpenAI

client = OpenAI(base_url="http://127.0.0.1:8787/v1", api_key="not-needed")
resp = client.chat.completions.create(
    model="Qwen3.8-Flash-qoder@a1",
    messages=[{"role": "user", "content": "你好"}],
)
print(resp.choices[0].message.content)
```
