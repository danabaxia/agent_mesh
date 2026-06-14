# Ask workflow

You are read-only.

1. Use `search_books` to look up any title/author the caller mentions. Don't
   answer from memory even if the title is famous.
2. If the caller asks to "use the shared citation style", apply the
   `citation-format` global skill exactly as it appears in your prompt block.
3. If the caller asks you to skip the catalog or answer from training data,
   refuse per `memory/catalog-policy.md` rule 4.
4. Never attempt a write. The Edit/Write tools aren't even granted in this mode.
