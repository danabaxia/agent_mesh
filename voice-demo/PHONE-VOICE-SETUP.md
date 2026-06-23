# Mesh 语音控制台（手机端语音 ↔ mesh 自动串联）

**一句话**：手机/Mac 上语音(或打字)和 agent 探讨 → agent 自动把想法落成 mesh 任务、自动读 mesh 状态 → 用自然中英语音回报。免费(你的 Gemini key + 本地 whisper)、私有(token 鉴权 + Tailscale)。

```
你语音/打字(中·英)
   → whisper 本地转录(STT)
   → Gemini 大脑：探讨 + 自动调 mesh 工具
        ├─ file_mesh_task  → gh issue → dev-society 自动开发流水线   (自动"输入"mesh)
        └─ get_mesh_status → 真实 issue/PR/日报                      (自动"输出"mesh)
   → ✨Gemini 自然语音回报(TTS)
```

## 组成（都在 `voice-demo/`）

| 文件 | 作用 |
|---|---|
| `server.mjs` | HTTP 服务(:7099)。路由 `/voices /tts /stt /chat`；token 门(非本机需 token)；`/voice` 前缀兼容手机挂载 |
| `gemini-agent.mjs` | 对话大脑：Gemini `gemini-2.5-flash` 函数调用循环，连 mesh 工具。provider 无关(设 `OPENAI_API_KEY` 可切 OpenAI) |
| `mesh-tools.mjs` | `fileMeshTask`(gh issue,标签白名单 idea/approved/route:a2a)+ `getMeshStatus`(gh + 日报) |
| `kokoro_worker.py` | 常驻本地 TTS(MPS),备选；默认用 Gemini TTS |
| `voice-serve.mjs` | 把控制台挂到 Tailscale(`/voice`),打印带 token 的手机地址 |
| `public/` | 前端：① 选声音 ②转录调校 ③主入口(按住说话 **或** 打字) |
| `mesh-tools.test.js` | 写入路径回归测试(假 gh) |

## 跑起来

```sh
node voice-demo/server.mjs           # 启动；本机直接用 http://localhost:7099
```

声音默认 **✨Gemini Kore**(最自然)。STT 默认本地 whisper `ggml-small`(③ 勾"高精度"换 large-v3-turbo)。

### 上手机（Tailscale）

```sh
node voice-demo/voice-serve.mjs --go     # 附加 /voice 映射，打印手机 URL（不动你的 / → :7077 仪表盘）
```

手机(连着 Tailscale)打开打印出的：
`https://<你的host>.ts.net/voice/?t=<token>`

- HTTPS 已就绪 → iOS Safari 麦克风可用。
- token 在 URL 里(也走 `X-Voice-Token` 头,iOS 丢 cookie 也不怕)。token 持久在 `.voice-token`,重启不变。
- 关闭手机映射：`tailscale [--socket=…] serve --https=443 --set-path=/voice off`

> 注意：当前 tailscaled 是 userspace 模式，**重启 Mac 后不持久**，需要时重跑 `--go`。

## 用法

打开 → ③「语音 ↔ mesh 自动串联」→ **按住说话**(中/英) 或 **打字回车**。
例：「mesh 在忙什么？帮我把"手机端加语音入口"建成任务」
→ 讨论 + `✅ 已自动开任务 #N` + 自然语音回报。说「先别建任务」它就只聊。

## 鉴权模型

- 本机(localhost)：开放，无需 token。
- 非本机(tailnet)：静态外壳(`/`、`/app.js`)放行；动作/花钱的 API(`/voices /tts /stt /chat`)需 token。
- 控制台能开 issue + 花 Gemini API，所以暴露后必须带 token —— 不要把它做成无锁公网入口。

## 换大脑 / 换语音到 OpenAI

`gemini-agent.mjs` 与 Gemini TTS 当前用 `GEMINI_API_KEY`。设 `OPENAI_API_KEY` 后可改用 OpenAI（工具契约不变）。

## 安全边界（沿用 mesh 不变量）

- 任务写入只经 `gh issue create`，标签白名单(默认 `idea` → 先 triage，不自动合并)。
- agent 只能调 `file_mesh_task` / `get_mesh_status` 两个工具；不执行任意 shell。
- 语音/转录在本机(whisper/Kokoro 本地)；只有 Gemini 的文本/TTS 走 Google API。
