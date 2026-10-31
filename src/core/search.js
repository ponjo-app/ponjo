// Searching text, the same in the find bar (web/find.js) and in the
// project's files (src/host/project-service.js): what is typed, as plain
// text unless `regex`, case ignored unless `matchCase`, and with `wholeWord`
// only where no letter, digit or _ is next to it.

const WORD = '[\\p{L}\\p{N}_]';

/**
 * The global regular expression for `query` under `options` ({ matchCase,
 * wholeWord, regex }); null when there is nothing to find, or the query is
 * not a regular expression.
 */
export function searchPattern(query, { matchCase = false, wholeWord = false, regex = false } = {}) {
  if (typeof query !== 'string' || query === '') return null;
  let source = regex ? query : query.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  if (wholeWord) source = `(?<!${WORD})(?:${source})(?!${WORD})`;
  try {
    return new RegExp(source, matchCase ? 'gu' : 'giu');
  } catch {
    return null;
  }
}

/** The matches of `pattern` (from searchPattern) in `text`, empty ones left out: [start, end, match]. */
export function matches(text, pattern) {
  if (!pattern) return [];
  return [...text.matchAll(pattern)].filter((m) => m[0] !== '').map((m) => [m.index, m.index + m[0].length, m]);
}

/**
 * What replaces `match` (a match of a regular expression): `template` with
 * $& the match, $1 to $99 its groups, $<name> a named one and $$ a $, as
 * String.prototype.replace reads it.
 */
export function expand(template, match) {
  return template.replace(/\$(\$|&|\d{1,2}|<([^>]*)>)/g, (all, what, name) => {
    if (what === '$') return '$';
    if (what === '&') return match[0];
    if (name !== undefined) return match.groups ? (match.groups[name] ?? '') : all;
    // $12 is group 12 if there is one, else group 1 and a 2.
    const n = Number(what);
    if (n >= 1 && n < match.length) return match[n] ?? '';
    if (what.length === 2 && Number(what[0]) >= 1 && Number(what[0]) < match.length) return (match[Number(what[0])] ?? '') + what[1];
    return all;
  });
}
