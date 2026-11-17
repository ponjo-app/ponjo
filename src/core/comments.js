// The sidecar, version 3 (spec/SPEC.md): `X.comments.jsonl`, a first
// line `{"comments":3}` and then one comment per line. A comment never
// changes or goes; resolving is a comment. Threads, who is
// mentioned and who is asked are read from the comments, never stored.
// Pure, so the doc host and the page read a sidecar the same way.

import { NAME_PATTERN, parseMentions } from './mentions.js';
import { createAnchor, locate } from './anchor.js';
import { changedRegions, diffEdits, lineMatches } from './diff.js';

export const FORMAT_VERSION = 3;
const COMMENT_ID = /^c_[A-Za-z0-9_-]{6,}$/;
const AT = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?Z$/;

const ID_ALPHABET = '0123456789abcdefghijklmnopqrstuvwxyz';

/** Random id such as `c_k3x9q2m7pa` (prefix `c` for a comment, `u` for a person). */
export function newId(prefix) {
  const bytes = globalThis.crypto.getRandomValues(new Uint8Array(10));
  let id = '';
  for (const byte of bytes) id += ID_ALPHABET[byte % ID_ALPHABET.length];
  return `${prefix}_${id}`;
}

/**
 * Read a sidecar's text (§2, §4). `lines` keeps every line after the first
 * in order, each `{ text, comment }` with `comment` null for a line that is
 * not one (reported in `bad`, skipped, and kept as it is when the file is
 * written again). Of lines with the same id, the first is the comment.
 * `problem` is 'older' or 'newer' when the first line is another version and
 * 'invalid' when it is not a header at all; the lines are still read, to
 * show, but the file must not be written (§2).
 */
export function parseSidecar(text) {
  const all = text.split('\n');
  if (all.at(-1) === '') all.pop();
  let header;
  try {
    header = JSON.parse(all[0] ?? '');
  } catch {
    header = null;
  }
  const problem = !isObject(header) || !Number.isInteger(header.comments) ? 'invalid' : header.comments < FORMAT_VERSION ? 'older' : header.comments > FORMAT_VERSION ? 'newer' : null;
  const lines = [];
  const bad = [];
  const seen = new Set();
  all.slice(1).forEach((line, i) => {
    let comment = null;
    try {
      comment = JSON.parse(line);
    } catch {
      // not JSON
    }
    const why = comment === null ? 'not JSON' : invalid(comment);
    if (why) {
      bad.push({ line: i + 2, error: why });
      lines.push({ text: line, comment: null });
    } else if (!seen.has(comment.id)) {
      seen.add(comment.id);
      lines.push({ text: line, comment });
    }
  });
  return { lines, bad, problem };
}

/** A sidecar's text: the header, then `lines` (from parseSidecar, or added). */
export function serializeSidecar(lines) {
  return [JSON.stringify({ comments: FORMAT_VERSION }), ...lines.map((l) => l.text ?? JSON.stringify(l.comment))].join('\n') + '\n';
}

// Why `c` is not a valid comment (§2), or null.
function invalid(c) {
  if (!isObject(c)) return 'not an object';
  if (typeof c.id !== 'string' || !COMMENT_ID.test(c.id)) return 'bad id';
  if (c.thread !== undefined && (typeof c.thread !== 'string' || !COMMENT_ID.test(c.thread))) return 'bad thread';
  if (c.anchor !== undefined && c.anchor !== null && !validAnchor(c.anchor)) return 'bad anchor';
  if (!isObject(c.by) || typeof c.by.id !== 'string' || !c.by.id || !NAME_PATTERN.test(c.by.name ?? '') || !['human', 'ai'].includes(c.by.kind)) return 'bad by';
  if (typeof c.at !== 'string' || !AT.test(c.at)) return 'bad at';
  if (typeof c.body !== 'string' || (c.body.trim() === '' && c.resolved !== true && !c.thread)) return 'bad body';
  for (const key of ['resolved', 'conflict', 'failed']) if (c[key] !== undefined && c[key] !== true) return `bad ${key}`;
  return null;
}

/**
 * A new comment as the sidecar holds it (§2), whoever writes it: a first
 * comment on `anchor` (null for the whole doc) or a reply in `thread`, by
 * `by` at `at`, resolving its thread with `resolved`. Who may resolve is
 * the doc host's to decide; the id is made here.
 */
export function newComment({ thread, anchor = null, body, resolved }, { by, at }) {
  return {
    id: newId('c'),
    ...(thread !== undefined ? { thread } : { anchor }),
    by,
    at,
    body,
    ...(resolved === true ? { resolved: true } : {}),
  };
}

/**
 * What a buddy's run appended to its copy of the sidecar
 * (docs/agent-config.md, Comments): lines in `after` that were not in
 * `before` and have no `id` (a changed comment has one), each with `line`,
 * its place among them from 0 (PONJO_GROUPS names a comment by it). They
 * are the lines `{ anchor: { exact }, body }`, `{ body }` or `{ thread, body }`,
 * made comments `by` the buddy `at` a time; a reply needs a thread of
 * `threads`, and a quote found other than once in `text` (the buddy's copy
 * of the doc as it left it, the text it quoted) is on the whole doc.
 * Anything else is skipped, and so is a line's `resolved`: only people
 * resolve.
 */
export function appendedComments(before, after, { text, by, at, threads }) {
  const had = new Set(before.split('\n'));
  const comments = [];
  let line = -1;
  for (const raw of after.split('\n')) {
    if (!raw.trim() || had.has(raw)) continue;
    line += 1;
    let parsed;
    try {
      parsed = JSON.parse(raw);
    } catch {
      continue;
    }
    if (!isObject(parsed) || parsed.id !== undefined) continue;
    if (typeof parsed.body !== 'string' || !parsed.body.trim()) continue;
    if (parsed.thread !== undefined && !threads.has(parsed.thread)) continue;
    comments.push({
      line,
      comment: newComment({
        thread: parsed.thread,
        anchor: parsed.thread === undefined ? quoted(text, parsed.anchor?.exact) : undefined,
        body: parsed.body.trim(),
      }, { by, at }),
    });
  }
  return comments;
}

// The anchor of `exact` when it is in `text` once, else null. An agent may
// quote a hard-wrapped line as one, or the other way round, so a quote not
// found as it is is looked for with any run of whitespace standing for any
// other.
function quoted(text, exact) {
  if (typeof exact !== 'string' || !exact.trim()) return null;
  const escape = (part) => part.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return once(text, escape(exact)) ?? once(text, exact.trim().split(/\s+/).map(escape).join('\\s+'));
}

// The anchor of the one match of `pattern` in `text`, else null.
function once(text, pattern) {
  const regex = new RegExp(pattern, 'g');
  const found = regex.exec(text);
  if (!found) return null;
  regex.lastIndex = found.index + 1;
  if (regex.exec(text)) return null;
  return createAnchor(text, found.index, found.index + found[0].length);
}

/** Whether `anchor` is `{ exact, prefix, suffix, start }` (§3). */
export function validAnchor(anchor) {
  return isObject(anchor) && typeof anchor.exact === 'string' && anchor.exact.length > 0
    && typeof anchor.prefix === 'string' && anchor.prefix.length <= 32
    && typeof anchor.suffix === 'string' && anchor.suffix.length <= 32
    && Number.isInteger(anchor.start) && anchor.start >= 0;
}

const byTime = (a, b) => (a.at < b.at ? -1 : a.at > b.at ? 1 : a.id < b.id ? -1 : a.id > b.id ? 1 : 0);

/**
 * Where a thread's `anchor`, on text `base`, is once `base` was edited into
 * `edited` and that edit landed, the doc now `text` (§3): its quote with
 * the whole of each change the edit made over it, in whole words; null
 * when the edit left its quote as it was.
 */
export function movedAnchor(anchor, base, edited, text) {
  const found = anchor && locate(base, anchor);
  if (!found) return null;
  let start = null;
  let end = null;
  let shift = 0;
  for (const { from, to, edit } of diffEdits(base, edited)) {
    const after = edit.start + edit.after.length;
    if (start === null && from > found.start) start = found.start + shift;
    if (start === null && (from === found.start || to > found.start)) start = edit.start;
    if (from >= found.end) break;
    end = to >= found.end ? after : null;
    shift = after - to;
    if (end !== null) break;
  }
  start ??= found.start + shift;
  end ??= found.end + shift;
  if (start >= end || edited.slice(start, end) === base.slice(found.start, found.end)) return null;
  const now = locate(text, createAnchor(edited, start, end));
  return now && createAnchor(text, now.start, now.end);
}

/**
 * A reply's edits, from `base` to `edited`, split by place (docs/user-experience.md,
 * No edit without a comment): `inside`, `base` with only the edits to the
 * paragraphs its thread's `anchor` is on; then `elsewhere`, each other
 * place in turn, `{ doc, anchor }`: the text once its edits are made too,
 * and an anchor on what they wrote there, in whole words, or null (the
 * whole doc) where they only removed. A place is a paragraph changed where
 * it was; paragraphs added or removed next to each other are one place. A
 * thread on the whole doc, or not found, keeps them all.
 */
export function editsByPlace(base, edited, anchor) {
  const found = anchor && locate(base, anchor);
  if (!found) return { inside: edited, elsewhere: [] };
  const a = paragraphs(base);
  const b = paragraphs(edited);
  const map = lineMatches(a.map((p) => p.text), b.map((p) => p.text));
  const regions = map ? changedRegions(map, a.length, b.length) : [[0, a.length, 0, b.length]];
  const at = (list, i, text) => (i < list.length ? list[i].from : text.length);
  // Each place: [from, to) of `base`, paragraphs and the breaks after them, and what replaces it.
  const places = regions.flatMap(([i, j, k, l]) => (j - i === l - k ? [...Array(j - i).keys()].map((n) => [i + n, i + n + 1, k + n, k + n + 1]) : [[i, j, k, l]]))
    .map(([i, j, k, l]) => ({ from: at(a, i, base), to: at(a, j, base), insert: edited.slice(at(b, k, edited), at(b, l, edited)) }));
  const near = (place) => place.from <= found.end && found.start < Math.max(place.to, place.from + 1);
  const apply = (picked) => picked.reduceRight((text, p) => text.slice(0, p.from) + p.insert + text.slice(p.to), base);
  const made = places.filter(near);
  const inside = apply(made);
  const elsewhere = places.filter((p) => !near(p)).map((place) => {
    made.push(place);
    made.sort((x, y) => x.from - y.from);
    const doc = apply(made);
    const start = made.filter((p) => p.from < place.from).reduce((x, p) => x + p.insert.length - (p.to - p.from), place.from);
    const changes = diffEdits(base.slice(place.from, place.to), place.insert);
    if (!changes.some((c) => c.edit.after.trim())) return { doc, anchor: null };
    const first = changes.find((c) => c.edit.after.trim());
    const last = changes.findLast((c) => c.edit.after.trim());
    const quote = doc.slice(start + first.edit.start, start + last.edit.start + last.edit.after.length);
    const from = start + first.edit.start + (quote.length - quote.trimStart().length);
    return { doc, anchor: createAnchor(doc, from, from + quote.trim().length) };
  });
  return { inside, elsewhere };
}

// A text's paragraphs, split at blank lines: each { text, from }.
function paragraphs(text) {
  let from = 0;
  return text.split('\n\n').map((part) => {
    const paragraph = { text: part, from };
    from += part.length + 2;
    return paragraph;
  });
}

/**
 * The threads in `comments` (§4): each `{ id, anchor, resolved, comments }`,
 * its first comment then its replies, ordered by `at`, then `id`; threads in
 * the order of their first comments. A thread is resolved when its latest
 * comment says so: any comment without `resolved` reopens it. A reply whose
 * first comment is missing is left out. `mentionable` ([{ id, name }]) is who an @name can mean (§6); each comment
 * gets `mentions`, the ids it mentions. A thread's `anchor` is the latest of
 * its comments' anchors whose quote is in the doc's `text`, when given (§3);
 * else the latest found there; else the latest.
 */
export function threadsOf(comments, mentionable = [], text = null) {
  const firsts = comments.filter((c) => c.thread === undefined).sort(byTime);
  return firsts.map((first) => {
    const all = [first, ...comments.filter((c) => c.thread === first.id).sort(byTime)]
      .map((c) => ({ ...c, mentions: parseMentions(c.body, mentionable) }));
    // A buddy's reply that rewrote the thread's text moves it; undoing that edit moves it back (§3):
    // the latest anchor whose quote is in the text as it is wins over a later one only found near it.
    const anchors = all.filter((c) => c.anchor).map((c) => c.anchor);
    const found = text === null ? [] : anchors.map((a) => locate(text, a));
    const latest = (ok) => anchors[found.findLastIndex(ok)];
    const anchor = first.anchor ? latest((f) => f?.method === 'exact') ?? latest(Boolean) ?? anchors.at(-1) : null;
    return { id: first.id, anchor, resolved: all.at(-1).resolved === true, comments: all };
  });
}

/**
 * The ids the open `thread` (from threadsOf) asks: each X that a comment
 * by one of `askers` (the ids that may ask) asks, until the thread is
 * resolved: X's comments there do not end it. A comment asks whom it @mentions; one that mentions no one
 * asks the thread's others: the one that opened it and each that an asker
 * @mentioned there before, never an asker. An empty one (it reopened the
 * thread) asks no one (docs/architecture.md, Who answers). Resolving drops
 * what was asked before it, so reopening asks no one.
 */
export function askedOf(thread, askers) {
  return [...askedBy(thread, askers).keys()];
}

/**
 * The same, each with who asked it: Map(buddy id → the id of the latest of
 * `askers` who asks it). `taken(comment)` says whether a comment of theirs
 * may ask: one that does not is skipped.
 */
export function askedBy(thread, askers, taken = () => true) {
  const asked = new Map();
  if (thread.resolved) return asked;
  const theirs = [thread.comments[0].by.id].filter((id) => !askers.includes(id));
  thread.comments.forEach((c) => {
    if (c.resolved) asked.clear();
    if (!askers.includes(c.by.id) || c.body.trim() === '' || !taken(c)) return;
    for (const id of c.mentions.length > 0 ? c.mentions : theirs) if (!askers.includes(id)) asked.set(id, c.by.id);
    for (const id of c.mentions) if (!theirs.includes(id) && !askers.includes(id)) theirs.push(id);
  });
  return asked;
}

/**
 * Who a person is in the comments: for each human id, the name in their
 * latest comment (§4): [{ id, name }].
 */
export function peopleOf(comments) {
  const latest = new Map();
  for (const c of [...comments].sort(byTime)) if (c.by.kind === 'human') latest.set(c.by.id, c.by.name);
  return [...latest].map(([id, name]) => ({ id, name }));
}

function isObject(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}
