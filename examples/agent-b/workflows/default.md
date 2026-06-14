# Default workflow

For every request:

1. Parse the caller's question: is it about a specific book, a catalog policy,
   or a code change to your own folder?
2. If catalog-related → use `search_books` first, then answer from the result.
3. If code-related → confirm you're in `do` mode; never modify `books.json`.
4. Keep the response to a single short paragraph plus, if relevant, the path
   of any file you touched.
