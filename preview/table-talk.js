// Talk at a game's table (site/spy.html, site/werewolf.html) that the rules
// do not ask for: the spy's discussion, and the chat before a game and after
// it. How it comes to rest is the poker table's (poker-world.js): a line
// wakes the AI players it names; a person's line to the whole table wakes
// every AI player, and one answer lands; a line this deep in replies wakes
// no one. Each world keeps its lines in a list, each line { id (its place
// in the list, from 1), by, text, to (the players it names), depth, about
// (the line it answers), at (ISO time), for (an AI player's line: for whom
// its run was) } and the world's own marks.

export const DEPTH = 2; // nobody replies to a reply forever
export const MAX_LINE = 240; // characters of a line of chat

// A time for a line or an ask, each later than the last (the runtime tells asks apart by them).
let last = 0;
export const stamp = () => new Date((last = Math.max(Date.now(), last + 1))).toISOString();

// The players of `ids` that `text` names, by the name each goes by (`nameOf`; a person with no name by none).
export const named = (ids, nameOf, text) => ids.filter((id) => nameOf(id) && new RegExp(`\\b${nameOf(id).replace(/\W/g, '\\$&')}\\b`, 'i').test(text));

// Whether `line` wakes AI player `id`.
export const concerns = (line, id, isPerson) => line.by !== id && line.depth < DEPTH && (line.to.includes(id) || (isPerson(line.by) && !line.to.length));

/**
 * Adds to `lines` the line `by` says, `text` naming `to`, answering `about`
 * (a line, or null), with `marks` (the world's own); returns it, or null if
 * `about` is a person's line to everyone that an AI player has answered already.
 */
export function say(lines, { by, text, to, about = null, for: those, isPerson, ...marks }) {
  if (about && isPerson(about.by) && !about.to.length && !isPerson(by) && lines.some((l) => l.about === about.id && !isPerson(l.by))) return null;
  const line = { id: lines.length + 1, by, text, to: to.filter((id) => id !== by), depth: about ? about.depth + 1 : isPerson(by) ? 0 : 1, about: about?.id ?? null, at: stamp(), ...(those ? { for: those } : {}), ...marks };
  lines.push(line);
  return line;
}

// What `lines` ask of AI player `id` (Asks, runtime.js), each `${key}:${line id}`, from whoever said it.
export const asks = (lines, id, isPerson, key) => lines.filter((l) => concerns(l, id, isPerson)).map((l) => ({
  id: `${key}:${l.id}`, agent: id, at: l.at, until: l.at,
  ...(isPerson(l.by) ? { from: l.by } : { from: l.by, for: l.for, depth: l.depth - 1 }), // an AI player's line asks for whom its run was
}));

// The lines the asks of `asked` made by `asks` with `key` are about, oldest first.
export const linesOf = (lines, asked, key) => asked.filter((a) => a.id.startsWith(`${key}:`)).map((a) => lines[Number(a.id.slice(key.length + 1)) - 1]);
