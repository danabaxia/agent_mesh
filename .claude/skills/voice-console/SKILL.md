---
name: voice-console
description: Use when starting, exposing, using, debugging, or extending the phone VOICE console for the mesh (the `voice-demo/` app) — hands-free talk-to-your-mesh from a phone (whisper STT → Gemini agent with mesh tools → Gemini TTS), incl. how to run it, expose it to a phone over Tailscale, the forced-tool-decision design, server-owned session memory, and the eyes-free/driving UX. Trigger on "start/serve the voice console", "talk to the mesh by voice", "voice on my phone", "hands-free / driving voice", "voice agent forgot / timed out / no reply / didn't act", or any work under `voice-demo/`.
---

# Phone Voice Console (`voice-demo/`)

A private, phone-first VOICE front-door to the mesh. The owner talks (or types) hands-free; a Gemini concierge ("门房") discusses, drives the mesh (files tasks, reads status/code, dispatches issues, asks real agents ask-only), and replies in natural bilingual voice. Local whisper does STT; Gemini does the brain + TTS. Served locally and reachable from the phone over Tailscale HTTPS. It is an **external front-door**, NOT a registered mesh agent (same pattern as the `/m` Mobile Concierge).

## Run it

```sh
node voice-demo/server.mjs            # serves http://localhost:7099 (localhost = open)
node voice-demo/voice-serve.mjs --go  # expose to the phone over Tailscale at /voice (additive)
```

- Phone URL: `https://<host>.ts.net/voice/?t=<token>` (token printed at startup + persisted in `voice-demo/.voice-token`; needed off-localhost). Requires `--enable-chat` on the dashboard only for the `ask_mesh_agent` path (see below).
- Brain + TTS use `GEMINI_API_KEY` (free tier ok). Provider-swappable via `OPENAI_API_KEY`.
- STT = local `whisper-cli` (`brew install whisper-cpp`) + a model in `voice-demo/models/` (gitignored). TTS default = Gemini neural voice (owner-approved as natural); Kokoro (local, on M-series MPS via an arm64 venv) and macOS `say` are fallbacks.

## Architecture — the ONE design rule

**Every turn is a forced tool decision.** `gemini-agent.mjs` runs Gemini with
`functionCallingConfig.mode:'ANY'` and a `respond_to_owner({text})` tool. The model
MUST emit a structured call each hop: either an **action** tool (do something) or
`respond_to_owner` (talk). There is no free-text path.

This is the load-bearing decision. It STRUCTURALLY eliminates the whole bug class that
otherwise shows up as: an empty `(无回复)` reply, or the model saying "我理解/我会去做/
请稍等" and then doing nothing (announce-without-acting) on file/ask/dispatch. Do NOT
"fix" those symptoms with regex on the reply text — that is whack-a-mole and was
explicitly removed. If a NEW "it acknowledged but didn't act" surfaces, the fix is
almost always: the action it needed has **no tool**, or the tool description is unclear
— add/clarify the tool, don't pattern-match the prose.

## The门房's tools (`mesh-tools.mjs`)

- `get_mesh_status` · `list_mesh_agents` · `list_repo_tree` / `read_repo_file` / `search_repo` — read the live mesh + its real code.
- `file_mesh_task({title,body,labels})` — create a task (gh issue, label-allowlist idea/approved/route:a2a). Async "get work done later".
- `set_issue_labels({number,labels})` — act on an EXISTING issue (relabel idea→approved+route:a2a to dispatch it for auto-build). The ONLY way to make the mesh act on an already-open issue.
- `ask_mesh_agent({agent,question})` — ASK a real served agent (claude) ask-only via the dashboard console (`POST /api/agent/<name>/message`). Sync "get an answer now" (~30–60s). Requires the dashboard started with `--enable-chat`; token at `~/.agent-mesh/deploy/dev-mesh/.agent-mesh/dashboard-token`. Slow → the client plays a "still thinking" heartbeat earcon.

## Memory & eyes-free safety (don't regress these)

- **Session memory is server-owned.** The server keeps the conversation per `session` id (persisted to `.sessions.json`, gitignored), source of truth, surviving phone reload / iOS tab-suspend. The client sends a stable localStorage session id and re-hydrates from `GET /history?session=`. Never put conversation memory only in the client array — iOS wipes it ("随时忘记"). The prompt also tells the门房 the recent turns ARE its memory so it never claims "no access to chat history".
- **confirm-before-file is code-enforced**, not prompt-trusted: a `file_mesh_task` is intercepted (turned into a "要记下来吗？" read-back) unless the prior assistant turn already asked. Prevents a misheard idea silently creating a junk task while driving.
- **Eyes-free (NHTSA 2s/12s):** hands-free continuous mode (tap 🚗 once → energy-VAD auto detect/capture/send/speak/resume; "停" ends), audible earcons for state, mid-idea pause grace, short replies + chunked TTS, iOS-suspend/mic-death recovery (watchdog + audio-graph rebuild). See `public/app.js`.

## Gotchas

- `node --check` the JS + `node --test voice-demo/mesh-tools.test.js` is the cheap gate.
- The dashboard runs from the **deploy** checkout (`~/.agent-mesh/deploy/dev-mesh`), not the working copy — `ask_mesh_agent` routes there so consults show as dashboard activity.
- Gemini TTS intermittently 400s on questions → the server retries + falls back. `gemini-2.0-flash` is retired; use `gemini-2.5-flash`.
- True sub-second voice (ChatGPT-style) needs a streaming/Live API not on the current key — this stack is "clearly faster, not magic".
