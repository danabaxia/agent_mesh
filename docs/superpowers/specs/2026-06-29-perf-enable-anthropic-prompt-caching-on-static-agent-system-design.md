# Prompt Caching for Static Agent System Prompts — Design

**Status:** in-review  
**Issue:** #659  
**Governs:** `src/delegate-invocation.js` · `src/agent-context.js` · `src/config.js`

## Goal

Recover the `perf:3x-disjoint:latency_ms` regression introduced by PR #620
(Gemini brain layer), which deepened each agent's static system prompt and
compounded the cold-start penalty across concurrent disjoint peers.

This spec adds `cache_control: {"type": "ephemeral"}` to the static portion of
each agent's system-prompt block, so Anthropic's prompt-caching layer serves
that prefix at ~90% lower token cost and measurably lower time-to-first-token
across all three peers in a disjoint fan-out. No routing or logic changes.

## Background

The perf benchmark (`scripts/eval-perf.mjs`) measures the `3x-disjoint` latency
cell — three peers with non-overlapping declared intents, all cold-started in
parallel. The baseline is **28,634 ms**; after PR #620 the cell regressed to
**31,372 ms (+9.6%)**, with no wasted hops — meaning the regression is entirely
in per-peer cold-start latency, not in routing decisions.

Root cause: PR #620 added a Gemini brain layer that deepened each agent's
`--append-system-prompt` (obeyed `prompts/system.md` + framed memory).
`src/delegate-invocation.js` assembles this into a static prefix passed on every
spawn. In a 3-peer disjoint fan-out all three agents send their full system
prompts cold — no shared context. The deeper prompt compounded the cold-start
penalty across all three concurrent peers.

Anthropic prompt caching (`cache_control: {"type": "ephemeral"}`) caches a
static prompt prefix keyed on exact prefix content + org. Subsequent calls
within the cache TTL pay only the cache-read cost (~90% lower input-token cost,
with measurably lower TTFT). In a 3-peer disjoint fan-out all peers share the
same static prefix; in warm steady state all three read it from cache,
compounding the latency recovery across the concurrent cold starts.

The -3.2% cost improvement already observed in the regressed run suggests
sufficient budget headroom to absorb the one-time cache-write premium.

## Components

| Module | Responsibility | Purity |
|---|---|---|
| `src/delegate-invocation.js` | Insert `cache_control` breakpoint after the static system-prompt prefix (base + brain layer) and before the dynamic task-specific content — **mechanism TBD, gated on Phase 0 feasibility check** | impure shell |
| `src/agent-context.js` | `buildAgentRuntimePrompt` assembles the static identity/memory/mode prefix; may need to expose a structured boundary so the breakpoint can be inserted at the right split | impure shell |
| `src/config.js` | `AGENT_MESH_PROMPT_CACHE_DISABLED` escape hatch; `AGENT_MESH_PROMPT_CACHE_PREWARM` toggle; sane defaults | pure |

- **Telemetry analyzer (Phase 0)** — a pre-implementation inspection of existing delegated-run `cache_read_input_tokens` / `cache_creation_input_tokens` from recent usage logs to determine whether the static prefix is already being cached and what the per-peer hit/miss rate is across disjoint runs. Phase 0 gates Phase 1 with two explicit checks:
  1. **Hit/miss baseline:** confirm caching is not already happening before adding the breakpoint, and establish the current hit-rate baseline.
  2. **CLI feasibility gate:** confirm whether the `claude` CLI exposes a mechanism (e.g. a structured `--system-prompt-file`, a special annotation, or an env var) for expressing `cache_control: {"type":"ephemeral"}` breakpoints in a text system prompt. `src/delegate-invocation.js` currently passes the assembled prompt as a plain-text string via `--append-system-prompt` (line 62); `cache_control` is an Anthropic API message-block property, not a plain-text concept. **If no CLI mechanism exists, Phase 1 must either (a) switch to direct Anthropic API calls or (b) reframe the approach (e.g. rely on the CLI's automatic TTL-based caching if it handles this internally).** Phase 1 implementation approach is TBD until this gate passes.
- **Pre-warmer** — a cheap priming call for the shared static prefix before a disjoint fan-out, so concurrent peers read instead of each writing. **Failure-mode:** the pre-warm call is best-effort; if it fails (network error, timeout), the fan-out proceeds without it (peers cold-write their own prefixes on the first wave). The pre-warmer never blocks or gates the fan-out — it is a latency optimization only, consistent with the failure-is-data posture.
- **Perf benchmark hook (`eval-perf.mjs`)** — measures 3x-disjoint `latency_ms` in **warm-cache steady state**, and surfaces cache read/write attribution per peer.
- **Config** — cache TTL choice (5m vs 1h), pre-warm on/off, and a disable flag to revert to the current behavior.

## Data flow

1. **Phase 0:** the telemetry analyzer inspects delegated-run usage → determines whether the static system prompt is cached and whether disjoint peers read or write.
2. **Phase 1:** the system-prompt assembler emits a static prefix (base + brain layer) followed by the `cache_control` breakpoint, then dynamic content.
3. A delegated worker's Claude call sends the structured prompt; Anthropic caches the static prefix (write) or serves it from cache (read), keyed on exact prefix + org.
4. **3x-disjoint fan-out:** three peers send identical static prefixes. Two distinct warm-cache scenarios (different cost structures and guarantees):
   - **Warm cache via prior run within TTL** — a previous fan-out already wrote the prefix to cache; all three peers read immediately. Full steady-state gain; no write premium in this wave.
   - **Warm cache via pre-warmer** — the pre-warm call fires before the fan-out and writes the prefix; peers then read. One write premium paid upfront (pre-warm call), then three reads. Gain depends on pre-warm completing before the fan-out's first peer call.
   - **Cold simultaneous (no prior run, pre-warmer disabled or failed)** → all three write the prefix (race; the "first" write wins, others may also write) → no first-wave latency gain; steady-state subsequent waves read.
5. `eval-perf.mjs` measures warm-state 3x-disjoint latency and per-peer cache attribution → confirms the regression is recovered.

## Testing

- **Phase 0 verification:** the analyzer correctly reports current breakpoint placement and disjoint per-peer hit/miss from real usage logs (the gate decision).
- **Breakpoint placement:** the static system prefix (incl. PR #620 brain layer) is inside the `cache_control` segment; dynamic task content is outside it (cache not busted per task).
- **Prefix identity:** the static prefix is byte-identical across the three peers (a prerequisite for shared reads) — assert no per-peer variance leaks into the cached segment.
- **Warm-cache read hit:** a second run within TTL records `cache_read_input_tokens` for the static prefix (cache is actually hit), not another full write.
- **Disjoint warm latency:** in warm steady state, `perf:3x-disjoint:latency_ms` recovers toward/below the 28,634 ms baseline; assert improvement vs. the regressed 31,372 ms.
- **Cold-wave honesty:** a forced fully-cold disjoint fan-out shows writes (and the pre-warmer, if enabled, converts those to reads) — the test documents first-wave vs. steady-state behavior, not a false uniform win.
- **No logic/routing change:** precision/recall and wasted_hops on 3x-disjoint are unchanged (this is latency-only).
- **Cost:** steady-state cost does not regress (read discount offsets write premium); the one-time write premium is bounded.
- **Disable flag:** reverts to current behavior; perf matches pre-change.
- **Doc-figure conformance:** min-length/TTL/pricing assumptions match Anthropic's current docs (verified before quoting acceptance numbers).

## Out of scope

- **Routing or logic changes** — latency recovery via caching only; routing, peer selection, and reasoning are untouched.
- **Reducing the system-prompt size / trimming the PR #620 brain layer** — a separate lever; this caches the existing prompt rather than shrinking it.
- **Caching dynamic per-task content** — only the static prefix is cached; dynamic content stays outside the breakpoint.
- **Changing the perf baseline/budget mechanism** — owned by the baseline/budget ideas (#412/#324); this targets the latency cell.
- **Non-disjoint cells beyond incidental benefit** — the design targets the 3x-disjoint regression; other cells benefit only insofar as they share the static prefix.
- **Provider-agnostic caching** — Anthropic prompt caching specifically; the mesh spawns `claude -p`.
- **Asserting exact caching pricing/TTL without verification** — figures must be confirmed against Anthropic's current docs before being used as acceptance thresholds.
- **Path-guard / anti-spoof / write-boundary changes** — none; prompt-construction and config only.
