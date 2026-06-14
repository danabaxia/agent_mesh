---
name: citation-format
description: Shared house-style citation format every agent in the mesh should follow when quoting catalog entries or external references.
---

# citation-format

When citing a book, article, or other source, format it as:

> **Title** — Author *(Year)* · `<location>`

Where `<location>` is whatever shelf, page, or URL identifier the local agent
has (e.g. `shelf 3`, `p. 117`, `https://...`). Keep the citation on a single
line so logs and downstream agents can pattern-match it.

For multi-author works use `Author A & Author B`; for unknown authors use
`Unknown`. Never invent a year — omit the parenthetical if you don't have one.
