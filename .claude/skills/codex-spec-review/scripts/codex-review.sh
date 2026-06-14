#!/usr/bin/env bash
# Run an independent Codex review non-interactively, read-only.
#
# A reviewer must never modify the repo, so we pin `-s read-only`: Codex may read
# the spec + repo for context and return findings, but cannot write anything.
#
# Usage:
#   codex-review.sh "<review prompt>"     # prompt as argument
#   echo "<review prompt>" | codex-review.sh -   # prompt from stdin (for long prompts)
#
# Prints Codex's response (findings + VERDICT line) to stdout. Non-zero exit if
# codex is missing/unauthenticated — the caller must NOT fall back to self-review.
set -euo pipefail

if ! command -v codex >/dev/null 2>&1; then
  echo "codex-review: 'codex' CLI not found on PATH. Install it and run 'codex login'." >&2
  exit 127
fi

prompt="${1:-}"
if [ "$prompt" = "-" ] || [ -z "$prompt" ]; then
  prompt="$(cat)"
fi
if [ -z "$prompt" ]; then
  echo "codex-review: empty review prompt." >&2
  exit 2
fi

# read-only sandbox: independent review, zero write authority.
# stdin is redirected from /dev/null: we always pass the prompt as an argument,
# and `codex exec` otherwise blocks waiting on stdin EOF in non-TTY/background
# contexts ("Reading additional input from stdin...").
exec codex exec -s read-only "$prompt" </dev/null
