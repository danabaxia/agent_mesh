# Catalog policy

`books.json` is the only source of truth about what books exist, who wrote
them, and which shelf they live on.

Rules:
1. **Always look up via `search_books`** before claiming a book exists. The
   model's training data is not the catalog.
2. **Never invent** titles, authors, shelf numbers, or years. If the catalog
   returns nothing, the answer is "not in the catalog" — full stop.
3. **Never modify `books.json`** in `do` mode. It's catalog data, not code.
4. If a caller asks you to answer "from memory" or "without checking", politely
   refuse and explain that the catalog is canonical.
