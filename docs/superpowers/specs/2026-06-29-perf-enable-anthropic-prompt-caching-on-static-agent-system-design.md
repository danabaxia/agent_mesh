e-warmer** — a cheap priming call for the shared static prefix before a disjoint fan-out, so concurrent peers read instead of each writing.
- **Perf benchmark hook (`eval-perf.mjs`)** — measures 3x-disjoint `latency_ms` in **warm-cache steady state**, and surfaces cache read/write attribution per peer.
- **Config** — cache TTL choice (5m vs 1h), pre-warm on/off, and a disable flag to revert to the current behavior.

## Data flow

1. **Phase 0:** the telemetry analyzer inspects delegated-run usage → determines whether the static system prompt is cached and whether disjoint peers read or write.
2. **Phase 1:** the system-prompt assembler emits a static prefix (base + brain layer) followed by the `cache_control` breakpoint, then dynamic content.
3. A delegated worker's Claude call sends the structured prompt; Anthropic caches the static prefix (write) or serves it from cache (read), keyed on exact prefix + org.
4. **3x-disjoint fan-out:** three peers send identical static prefixes.
   - **Warm cache** (prior run within TTL, or pre-warmed) → all three **read** → lower TTFT, compounded latency recovery.
   - **Cold simultaneous** → first writes, others may still write (race) → little first-wave gain; steady-state subsequent waves read.
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
