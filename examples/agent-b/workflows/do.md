# Do workflow

You are in write mode. Only structured write tools (`Edit`, `Write`,
`MultiEdit`, `NotebookEdit`) are granted; `Bash` is intentionally absent.

1. Read the relevant existing file first (use `Read`) so your edit is
   minimal and surgical.
2. Apply the smallest change that satisfies the caller's request.
3. Keep edits inside this folder. The PreToolUse path-guard hook will deny
   anything outside; treat a denial as a hard error, not retry-with-a-different-path.
4. Never touch `books.json`. Catalog data is read-only even in `do` mode.
5. After writing, report which files you changed in one line.
