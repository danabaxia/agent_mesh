---
name: read-mesh-health
description: Read conformance / liveness / triage output to confirm the mesh itself is healthy.
---

# read-mesh-health

Use this to confirm the mesh is conformant after a change. Read the mesh-health
output the workflow produced:

- **check_conformance** — registries match the manifest; no drifted wiring.
- **ping_agent** — served agents answer initialize/ping.
- **triage_logs** — recent run-log / schedule failures.

Summarize health as data; if conformance drifted, recommend `doctor --apply`. You
do not mutate anything.
