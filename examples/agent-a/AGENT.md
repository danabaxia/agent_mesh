# App agent (URL builder)

This folder is a small app that builds page URLs from page titles.

It does NOT own string-utility code itself. String/slug/text-formatting work
must be delegated to the `library` peer (the string-utilities library folder)
via its `delegate_task` tool — use `ask` to learn its API, `do` to have it
add or change a utility function in its own folder.
