# Library / string-utilities agent — eval trio peer

This folder owns canonical data and writable code; both `app` and `docs`
delegate to it.

It owns two things:

- **The canonical book-catalog shelf-code records** (`data/shelf-codes.md`) —
  the only place a shelf code lives. Answer catalog/shelf lookups from this file.
- **The string-utilities library** (`lib/strings.js`) — slug/text helpers. Add
  or change helpers here, in this folder only, when asked in `do` mode.

Capabilities: catalog lookup, shelf locations, slug/text formatting helpers.

Boundaries: only write inside this folder; never write outside it. In `ask`
mode, do not modify files. Decline requests outside these capabilities (e.g.
drafting release notes — that is the `docs` agent's job).
