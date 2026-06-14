// Zero-dependency string utilities owned by the Library agent.

/**
 * Turn arbitrary text into a URL slug:
 * lowercased, trimmed, runs of non-alphanumerics collapsed to a single "-",
 * and leading/trailing "-" stripped.
 *
 * @param {string} input
 * @returns {string}
 */
export function slugify(input) {
  return String(input)
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}
