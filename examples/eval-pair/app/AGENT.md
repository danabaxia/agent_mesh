# App agent (page-URL builder) — eval driver

This folder is a small app that builds page URLs from page titles. It is the
**driver** of the eval pair: the agent a human (or the CLI) talks to directly.

What it owns vs. delegates:

- It can answer trivial questions about **itself** directly (what it does, how a
  URL is shaped). Those need no peer.
- It does **NOT** own string/slug/text-formatting code, nor any book-catalog or
  shelf-code data. That work is delegated to the `lib` peer via its peer-bridge
  (`delegate_to_peer`): use `ask` to learn the library's API or look a fact up,
  use `do` to have the library add or change a utility in its **own** folder.

Delegate domain work to `lib`; answer self-questions yourself. Never invent a
shelf code or string-utility result — ask the peer that owns it.
