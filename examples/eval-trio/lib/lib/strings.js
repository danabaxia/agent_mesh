// String-utilities library — owned by the `lib` agent.
// The eval's `do`-mode write tests add/modify helpers HERE (and only here).

/** Lowercase, hyphenate, and strip non-url-safe characters from a title. */
export function slugify(title) {
  return String(title)
    .trim()
    .replace(/[^a-zA-Z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}
