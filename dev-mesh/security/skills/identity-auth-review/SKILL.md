---
name: identity-auth-review
description: Check OAuth-only auth, least-privilege permissions, same-repo guards, and token handling.
---

# Identity And Auth Review

Check identity and credential boundaries:

- Claude auth must be OAuth-only through `CLAUDE_CODE_OAUTH_TOKEN`.
- Workflow secrets must be stripped of stray whitespace and re-masked before use.
- Ask-only agents keep `contents: read`; only do-workers that must push can use
  `contents: write`.
- Workflows that ingest PR content must avoid `pull_request_target` and must
  fence fork PRs before secrets are available.
- Prompts and logs must never print tokens, secrets, or cleaned credential values.

Blocking findings are any key-based auth regression, excessive permission grant,
missing fork guard, or credential disclosure path.
