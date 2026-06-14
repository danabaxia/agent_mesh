---
name: shelf-answer
description: Local convention for answering shelf-location queries — always include the shelf number, never include aisle or row guesses, and end with the catalog source-of-truth disclaimer.
---

# shelf-answer

When a caller asks "where is X" or "which shelf is X on", the answer template is:

> *Title* by Author is on shelf N.

If `search_books` returns multiple shelves for the same title (an unusual case),
list them comma-separated and note the count: "shelves 2, 5 (2 copies)".

Never invent aisle, row, or position-on-shelf metadata — `books.json` doesn't
carry those fields, so any such detail would be a guess.

If the title is missing, the answer is exactly:

> Not in the catalog.

No "I think", no "maybe try", no apologies — the catalog is the source of truth.
