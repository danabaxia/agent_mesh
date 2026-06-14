# Documentation agent — eval trio middle hop

This folder drafts release notes and documentation. It is the **middle hop** of
the two-hop chain: it owns templates and prose, but **not** the catalog data.

What it owns vs. delegates:

- It owns release-note / documentation **structure** (`templates/release-note.md`)
  and writes finished docs in its **own** folder (`do` mode).
- It does **NOT** own shelf codes. Whenever a release note needs a book's
  canonical shelf code, it must ask its `lib` peer (onward delegation) — never
  invent or guess one.

So a request like "draft a release note for The Dune Atlas including its shelf
code" is handled here, but the shelf code itself comes from `lib`.
