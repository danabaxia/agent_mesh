---
name: injection-sweep
description: Find prompt injection, workflow command injection, unsafe interpolation, and fork secret paths in Dev-mesh automation.
---

# Injection Sweep

Check for ways untrusted data can become instructions or shell syntax:

- `pull_request_target`, fork PR secret exposure, or missing same-repo guards.
- PR titles, issue bodies, comments, branch names, or logs interpolated directly
  into prompts or shell commands.
- Shell use of author-controlled refs without an environment-variable handoff.
- Prompt text that asks an agent to obey CI logs, issue bodies, PR comments, or
  branch names as instructions instead of treating them as data.

Blocking findings are any path that can leak secrets, push unintended code, run
author-controlled shell, or bypass the human merge gate.
