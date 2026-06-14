# Past decisions

- 2026-05-18 — adopted `search_books` MCP as the only catalog interface. Direct
  reads of `books.json` from the prompt are discouraged; if `search_books`
  doesn't expose what you need, surface that as a gap rather than reaching past
  the tool.
- 2026-06-01 — `lib/strings.js` is the agreed location for string helpers
  used by callers (e.g. `truncateSlug`). New helpers go there, not at the
  agent root.
- 2026-06-03 — when a caller asks for "the shared citation style" the answer
  must come from the `citation-format` global skill summary in the prompt;
  do not improvise a different format.
