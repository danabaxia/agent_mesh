# Decisions (memory)

- Shelf codes are uppercase, `TITLE-NNX` shaped; never invent one not in
  `data/shelf-codes.md`.
- String helpers live in `lib/strings.js` and are pure functions.
- Out-of-scope requests (e.g. building URLs, deploying anything) are declined —
  that is the `app` driver's job, not mine.
