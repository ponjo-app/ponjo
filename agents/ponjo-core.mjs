// The Ponjo agent's turn (docs/app/ponjo-agent.md), with no I/O of its own:
// the tools, the loop, the check of a proposal and each provider's infer.
// Imports nothing, so it runs in Node, next to ponjo.mjs, and in a browser
// (preview/doc-stub.js). Yours to change.

const STEPS = 20;
const MAX_READ = 20_000; // characters a read without `lines` returns
const MAX_FOUND = 100; // paths find, or lines grep, gives before it asks to narrow
const MAX_LINE = 500; // characters of a line grep shows
const MAX_LISTED = 200; // the project's files the first message lists; over that, its top folder's
const SIDECAR = '.comments.jsonl';
const ANY_TOOL = 'read, find, grep or comment';
const PATTERN = 'A JavaScript regular expression, not a glob. Case is ignored unless it has a capital letter.';

// The tools, as each provider's infer gets them: { name, description, parameters (a JSON schema) }.
const TOOLS = [
  {
    name: 'read',
    description: `Read a file, or list a folder. Each line comes after its number and a tab, which are not part of the file. A file over ${MAX_READ} characters read without lines gives its outline: read it in parts.`,
    parameters: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'The path of the file or folder.' },
        lines: { type: 'array', items: { type: 'integer' }, description: 'The first and last line to read, from 1.' },
      },
      required: ['path'],
    },
  },
  {
    name: 'find',
    description: `Find files by their path from the project's top, \`/\` between folders (like notes/rule.md): the paths the pattern matches, sorted, at most ${MAX_FOUND}.`,
    parameters: {
      type: 'object',
      properties: {
        pattern: { type: 'string', description: `${PATTERN} For rule.md anywhere: rule\\.md$.` },
        path: { type: 'string', description: 'The folder to search; the whole project if left out.' },
      },
      required: ['pattern'],
    },
  },
  {
    name: 'grep',
    description: `Search files for lines: each file's path, then the lines it matches, each after its number and a tab, as read gives them. At most ${MAX_FOUND} lines.`,
    parameters: {
      type: 'object',
      properties: {
        pattern: { type: 'string', description: PATTERN },
        path: { type: 'string', description: 'The folder or file to search; the whole project if left out.' },
      },
      required: ['pattern'],
    },
  },
  {
    name: 'comment',
    description: 'Comment as a member does: reply in the thread `thread`, or start a thread on `on`. It is your only way to change anything: a change to the doc is the `edits` of the comment that says why, and members can undo each comment\'s edits on their own. Each edit replaces `old`, quoted exactly from the doc and found there once, with `new`; one bad edit sends the comment back, saying what to fix. The edits apply at once, so what you read next has them; the comment is posted when your turn ends, which is at a step with no call.',
    parameters: {
      type: 'object',
      properties: {
        thread: { type: 'string', description: 'For a reply: the id of the thread, its first comment\'s.' },
        on: { type: 'string', description: 'For a new thread: the text it is about, quoted exactly from the doc as this comment\'s edits leave it, and found there once; "" for the whole doc.' },
        body: { type: 'string', description: 'What you say.' },
        edits: { type: 'array', items: { type: 'object', properties: { old: { type: 'string' }, new: { type: 'string' } }, required: ['old', 'new'] } },
        actions: { type: 'array', description: 'Actions outside the doc this comment proposes, from those the prompt lists, each carried out once it is posted and approved.', items: { type: 'object', properties: { action: { type: 'string' }, input: {} }, required: ['action'] } },
      },
      required: ['body'],
    },
  },
];

/**
 * One run of a buddy: `prompt` is stdin as is, `doc` and `sidecar` the
 * copies' paths in the project. `infer(messages, tools)` is one step of the
 * model (INFER) and resolves to { calls: [{ id, name, args }], text, sent, usage },
 * `args` the JSON the model wrote, `text` what it wrote besides, `sent` its
 * message as its API sent it and `usage` the tokens it took, as the API
 * counts them; `readFile(path)` to a file's text, a folder's entries (a
 * subfolder's ending in /) or null;
 * `resolve(path)` a path the model wrote as the copies' paths are written
 * (ponjo.mjs's inProject). Resolves, at a step with no call, to { doc,
 * sidecar, groups, actions, text }: the copies' new texts, the doc with every comment's
 * edits and the sidecar with a line for each comment, and `groups`, for
 * each comment with edits, { comment (its place among the lines), doc (the
 * doc after its edits) } (docs/app/agent-config.md, PONJO_GROUPS), `actions`,
 * { comment, action, input } for each action a comment proposes
 * (docs/runtime/README.md#outside-actions), and what
 * the model wrote in that last step. Throws when the turn fails.
 *
 * The messages are in one form for every provider: { role: 'user', content },
 * { role: 'assistant', calls, sent }, and { role: 'tool', id, content }, a
 * call's result. Each call of a step runs, in order.
 */
export async function turn({ prompt, doc, sidecar }, { infer, readFile, resolve = (path) => path }) {
  const texts = { doc: await readFile(doc) }; // the doc as the comments' edits leave it, which reads see
  const reads = (path) => (typeof path === 'string' && resolve(path) === doc ? texts.doc : readFile(path));
  // Nearly every turn needs the doc, so it comes with the prompt, as read gives it: a step saved.
  // What stays the same from one run to the next, the prompt's rules and the
  // doc, is one message, marked to cache; the situation (the prompt's last
  // part, from SITUATION on) another, after it.
  const cut = prompt.indexOf(`\n\n${SITUATION}\n\n`);
  const [rules, situation] = cut < 0 ? [prompt, ''] : [prompt.slice(0, cut), prompt.slice(cut + 2)];
  const opening = [rules, await listing(readFile, [doc, sidecar]), `The doc, ${doc}, as read gives it:\n\n${await read({ path: doc }, reads, doc)}`];
  const messages = [{ role: 'user', content: opening.filter(Boolean).join('\n\n'), cache: true }, ...(situation ? [{ role: 'user', content: situation }] : [])];
  const comments = []; // the sidecar's lines, as objects, added when the turn ends
  const groups = [];
  const actions = [];
  for (let step = 0; step < STEPS; step++) {
    const { calls, text, sent } = await infer(messages, TOOLS);
    messages.push({ role: 'assistant', calls, sent });
    if (!calls.length) {
      const before = await readFile(sidecar);
      const lines = comments.map((c) => `${JSON.stringify(c)}\n`).join('');
      return { doc: texts.doc, sidecar: `${before}${lines && before && !before.endsWith('\n') ? '\n' : ''}${lines}`, groups, actions, text: text.trim() };
    }
    for (const call of calls) messages.push({ role: 'tool', id: call.id, content: await use(call, { doc, sidecar, texts, comments, groups, actions, readFile, reads, resolve }) });
  }
  throw new Error(`The turn did not end in ${STEPS} steps.`);
}

// What a tool call gives back to the model.
async function use({ name, args: json }, { doc, sidecar, texts, comments, groups, actions, readFile, reads, resolve }) {
  let args;
  try {
    args = JSON.parse(json);
  } catch {
    return `The arguments are not JSON: ${json}`;
  }
  if (name === 'read') return read(args, reads, doc);
  if (name === 'find' || name === 'grep') return search(name, args, reads, resolve);
  if (name !== 'comment') return `No tool ${name}: call ${ANY_TOOL}.`;
  const { on, thread: to, body, edits = [], actions: proposed = [] } = args;
  if (typeof body !== 'string' || !body.trim() || (typeof on !== 'string') === (typeof to !== 'string') || !Array.isArray(edits)) return 'Not posted: comment takes { on, body, edits } for a new thread or { thread, body, edits } for a reply, body not empty, edits [{ old, new }] or left out.';
  if (!Array.isArray(proposed) || !proposed.every((a) => typeof a?.action === 'string')) return 'Not posted: actions is [{ action, input }] or left out.';
  // A thread of the doc, by the id of its first comment, as the comments file has it.
  const isThread = (await readFile(sidecar) ?? '').split('\n').some((line) => {
    try {
      const c = JSON.parse(line);
      return c?.id === to && c.thread === undefined;
    } catch {
      return false;
    }
  });
  if (to !== undefined && !isThread) return `Not posted: no thread ${to}. Its id is its first comment's, in the comments file.`;
  let edited;
  try {
    edited = applied(texts.doc, edits);
  } catch (error) {
    return `Not posted, and nothing changed. ${error.message}`;
  }
  let where = `as a reply in ${to}`;
  if (on !== undefined) {
    const { count, line } = on.trim() ? quoted(edited, on) : { count: 1 };
    if (count !== 1) return `Not posted, and nothing changed: on is ${count ? 'in the doc more than once: quote more of it' : 'not in the doc as your edits leave it: quote it from there'}, or give "" for the whole doc.`;
    where = on.trim() ? `on line ${line}` : 'on the whole doc';
  }
  comments.push(to !== undefined ? { thread: to, body } : on.trim() ? { anchor: { exact: on }, body } : { body });
  if (edits.length) {
    texts.doc = edited;
    groups.push({ comment: comments.length - 1, doc: edited });
  }
  for (const { action, input = null } of proposed) actions.push({ comment: comments.length - 1, action, input });
  return `Posted when your turn ends, ${where}${edits.length ? `, with its ${edits.length === 1 ? 'edit' : `${edits.length} edits`}, applied now: read the doc to see them` : ''}.`;
}

/**
 * How the app finds a comment's text `exact` in the doc's `text`
 * (src/core/comments.js, appendedComments): as it is, else with any run of
 * whitespace standing for any other, in the text with its line ends as \n.
 * `count` is 0, 1, or 2 for more; the app anchors the comment only on 1.
 * `line` is where the first is.
 */
export function quoted(text, exact) {
  const doc = text.replace(/^\uFEFF/, '').replace(/\r\n?/g, '\n');
  const escape = (part) => part.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  for (const pattern of exact.trim() ? [escape(exact), exact.trim().split(/\s+/).map(escape).join('\\s+')] : []) {
    const regex = new RegExp(pattern, 'g');
    const first = regex.exec(doc);
    if (!first) continue;
    regex.lastIndex = first.index + 1;
    return { count: regex.exec(doc) ? 2 : 1, line: doc.slice(0, first.index).split('\n').length };
  }
  return { count: 0 };
}

// A file read as it is, with a note when the doc's folder has one by the
// same path: models read a file a comment names from the project's top.
async function read({ path, lines }, readFile, doc) {
  const found = typeof path === 'string' ? await readFile(path) : null;
  const folder = doc.slice(0, doc.lastIndexOf('/') + 1);
  const near = folder && typeof path === 'string' && path && !path.startsWith(folder) && typeof (await readFile(folder + path)) === 'string' && folder + path;
  const note = near ? `${near} is there too: a file a comment names is from the doc's folder, ${folder}.` : '';
  if (found === null) return [`${path}: no such file, or not one you can read.`, note].filter(Boolean).join(' ');
  if (Array.isArray(found)) return found.join('\n') || '(an empty folder)';
  const all = linesOf(found);
  if (!lines && found.length > MAX_READ) return [outline(path, all), note].filter(Boolean).join('\n');
  const from = Math.max(1, lines?.[0] ?? 1);
  return [all.slice(from - 1, lines?.[1] ?? all.length).map((line, i) => `${from + i}\t${line}`).join('\n'), note && `(${note})`].filter(Boolean).join('\n');
}

const linesOf = (text) => text.replace(/\r?\n$/, '').split(/\r?\n/);

// find's or grep's answer: the files under `path` whose path (find) or lines
// (grep) match `pattern`, smart case as the sidebar's filter (web/files.js).
async function search(tool, { pattern, path = '' }, readFile, resolve) {
  if (typeof pattern !== 'string' || typeof path !== 'string') return `${tool} takes { pattern, path }, both strings.`;
  let match;
  try {
    match = new RegExp(pattern, /[A-Z]/.test(pattern) ? '' : 'i');
  } catch (error) {
    return `${error.message}. The pattern is a regular expression, not a glob: rule\\.md$, not **/rule.md.`;
  }
  const top = resolve(path);
  const files = typeof top === 'string' ? await under(top, readFile) : null;
  if (!files) return `${path}: no such ${tool === 'find' ? 'folder' : 'folder or file'}, or not one you can read.`;
  const shown = [];
  let found = 0;
  for (const file of files.sort((a, b) => a.localeCompare(b))) {
    if (tool === 'find') {
      if (match.test(file) && ++found <= MAX_FOUND) shown.push(file);
      continue;
    }
    const text = await readFile(file);
    if (typeof text !== 'string') continue;
    const lines = [];
    linesOf(text).forEach((line, i) => {
      if (match.test(line) && ++found <= MAX_FOUND) lines.push(`${i + 1}\t${line.length > MAX_LINE ? `${line.slice(0, MAX_LINE)}…` : line}`);
    });
    if (lines.length) shown.push(file, ...lines);
  }
  if (!found) return `No ${tool === 'find' ? 'path' : 'line'} matches ${pattern}${path ? ` in ${path}` : ''}.`;
  return [...shown, ...(found > MAX_FOUND ? [`${found - MAX_FOUND} more: narrow the pattern or the path.`] : [])].join('\n');
}

// The files at `path` by readFile, which gives a folder's entries (a
// subfolder's with a trailing /): the file itself, or every file in the
// folder and its subfolders, or more than `limit` of them; null when there is none.
async function under(path, readFile, limit = Infinity) {
  const found = await readFile(path);
  if (!Array.isArray(found)) return found === null ? null : [path];
  const paths = [];
  for (const entry of found) {
    if (paths.length > limit) break;
    const at = path === '' || path === '.' ? entry : `${path.replace(/\/$/, '')}/${entry}`;
    paths.push(...(entry.endsWith('/') ? (await under(at.slice(0, -1), readFile, limit - paths.length)) ?? [] : [at]));
  }
  return paths;
}

// The project's files as its sidebar shows them, for the first message, as
// a person sees them before they ask: every one, or over MAX_LISTED its top
// folder's entries. A file's sidecar is left out, as in the sidebar. Null
// when it holds only `copies`, as in doc mode.
async function listing(readFile, copies) {
  const all = (await under('', readFile, MAX_LISTED)) ?? [];
  const shown = (paths) => paths.filter((path) => !(path.endsWith(SIDECAR) && paths.includes(path.slice(0, -SIDECAR.length))));
  if (all.every((path) => copies.includes(path))) return null;
  if (all.length <= MAX_LISTED) return `The project's files:\n\n${shown(all).join('\n')}`;
  return `The project has more than ${MAX_LISTED} files: find them with find. Its top folder:\n\n${shown(await readFile('')).join('\n')}`;
}

// A long file's line count, and a Markdown file's headings with their lines.
function outline(path, all) {
  const about = `${path} has ${all.length} lines, too many to read at once: read it in parts.`;
  if (!/\.(md|markdown)$/i.test(path)) return about;
  const headings = [];
  let fenced = false;
  all.forEach((line, i) => {
    if (/^\s*(```|~~~)/.test(line)) fenced = !fenced;
    else if (!fenced && /^#{1,6}\s/.test(line)) headings.push({ at: i + 1, line });
  });
  const ranges = headings.map(({ at, line }, i) => `${at}-${(headings[i + 1]?.at ?? all.length + 1) - 1}\t${line}`);
  return [about, ...(ranges.length ? ['Its headings, with their lines:', ...ranges] : [])].join('\n');
}

/** `text` after `edits` ([{ old, new }]), all or none: throws what to fix. */
function applied(text, edits) {
  // read shows a CRLF doc's lines without their \r: a quote and its edit get them back.
  const eol = (part) => (text.includes('\r\n') ? part.replace(/\r?\n/g, '\r\n') : part);
  const spans = [];
  for (const [i, edit] of edits.entries()) {
    const which = `Edit ${i + 1}`;
    if (!['old', 'new'].every((key) => typeof edit?.[key] === 'string')) throw new Error(`${which}: old and new must be strings.`);
    const quote = eol(edit.old);
    const start = quote ? text.indexOf(quote) : -1;
    if (start < 0) throw new Error(`${which}: old ${edit.old ? 'is not in the doc: read it and quote it exactly' : 'is empty: quote the text to replace'}.`);
    if (text.includes(quote, start + 1)) throw new Error(`${which}: old is in the doc more than once: quote more of it.`);
    spans.push({ start, end: start + quote.length, by: eol(edit.new), which });
  }
  spans.sort((a, b) => a.start - b.start);
  let out = '';
  let at = 0;
  for (const { start, end, by, which } of spans) {
    if (start < at) throw new Error(`${which} overlaps another edit: make them one.`);
    out += text.slice(at, start) + by;
    at = end;
  }
  return out + text.slice(at);
}

// Where a failed run's reply sends the user: the failure, then what to change.
const SETTINGS = 'The provider, endpoint, model and key are in Settings > Agents > Ponjo agent.';
const HINTS = { 401: 'Check the API key.', 404: 'Check the endpoint and the model.' };

const CACHED = { type: 'ephemeral' };
/** The heading of the app's prompt's last part, which changes from run to run (src/core/prompt.js). */
export const SITUATION = 'The situation now:';

// Anthropic's web fetch (INFER.anthropic), and how many times a step that
// pauses while fetching is asked to go on before the turn fails.
const WEB_FETCH = { type: 'web_fetch_20260209', name: 'web_fetch' };
const MAX_PAUSES = 4;

/**
 * One step of the model, by provider: `INFER[provider](settings, url)` is
 * `infer` for `turn`, over that provider's API at `url`. `settings` are the
 * agent's: { endpoint, model, key, effort, web }. Each sends `tool_choice: auto`:
 * current Claude models refuse a forced tool call, and a step without one
 * ends the turn.
 */
export const INFER = {
  // Anthropic's Messages API. The model thinks as it needs, at `effort`; its
  // messages go back as they came, thinking included. Everything up to the
  // last message is cached, the mark moved each step, so a step pays in
  // full only for what is new. With `web` it may read web pages by
  // Anthropic's web fetch, which runs at Anthropic and opens only a URL
  // already in the messages: one in the thread or the doc, or on a page it
  // read. A step it pauses, fetching, is asked to go on, as one answer.
  // The last header lets a page call it with its visitor's own key
  // (site/poker.html); elsewhere it does nothing.
  anthropic: ({ model, key, effort, web = false }, url = 'https://api.anthropic.com/v1') => async (messages, tools) => {
    const request = (sent) => post(`${url}/messages`, { 'x-api-key': key, 'anthropic-version': '2023-06-01', 'anthropic-dangerous-direct-browser-access': 'true' }, {
      model,
      max_tokens: 16_000,
      output_config: { effort },
      tool_choice: { type: 'auto' },
      tools: [...tools.map(({ name, description, parameters }) => ({ name, description, input_schema: parameters })), ...(web ? [WEB_FETCH] : [])],
      messages: [...messages.map((m, i) => {
        const last = (i === messages.length - 1 || m.cache) && { cache_control: CACHED };
        if (m.role === 'assistant') return { role: 'assistant', content: m.sent };
        if (m.role === 'tool') return { role: 'user', content: [{ type: 'tool_result', tool_use_id: m.id, content: m.content, ...last }] };
        return { role: 'user', content: [{ type: 'text', text: m.content, ...last }] };
      }), ...(sent.length ? [{ role: 'assistant', content: sent }] : [])],
    });
    let sent = [];
    let usage;
    for (let paused = 0; ; paused++) {
      const reply = await request(sent);
      sent = [...sent, ...reply.content];
      usage = usage ? Object.fromEntries(Object.entries(reply.usage ?? {}).map(([k, v]) => [k, typeof v === 'number' ? v + (usage[k] ?? 0) : v])) : reply.usage;
      if (reply.stop_reason === 'refusal') throw new Error(`The model refused: ${reply.stop_details?.explanation ?? 'no reason given.'}`);
      if (reply.stop_reason === 'max_tokens') throw new Error('The model\'s answer was cut off at 16,000 tokens.');
      if (reply.stop_reason !== 'pause_turn') break;
      if (paused === MAX_PAUSES) throw new Error(`The model was still reading web pages after ${MAX_PAUSES + 1} requests.`);
    }
    const calls = sent.filter((block) => block.type === 'tool_use').map(({ id, name, input }) => ({ id, name, args: JSON.stringify(input) }));
    // The text after the last page it read: what it wrote before is on its way there.
    const after = sent.slice(sent.findLastIndex((block) => block.type.endsWith('_tool_result')) + 1);
    const text = after.filter((block) => block.type === 'text').map((block) => block.text).join('');
    return { calls, text, sent, usage };
  },
  // The Chat Completions API, which OpenAI, OpenRouter and others speak.
  openai: ({ endpoint, model, key, effort }, url = endpoint.replace(/\/+$/, '')) => async (messages, tools) => {
    const { choices: [{ message }], usage } = await post(`${url}/chat/completions`, { authorization: `Bearer ${key}` }, {
      model,
      reasoning_effort: effort,
      tool_choice: 'auto',
      tools: tools.map((tool) => ({ type: 'function', function: tool })),
      messages: messages.map((m) => (m.role === 'assistant' ? m.sent : m.role === 'tool' ? { role: 'tool', tool_call_id: m.id, content: m.content } : { role: m.role, content: m.content })),
    });
    const calls = (message.tool_calls ?? []).map(({ id, function: { name, arguments: args } }) => ({ id, name, args }));
    return { calls, text: message.content ?? '', sent: message, usage };
  },
  // Nebius Token Factory, where NVIDIA's Nemotron models run: Chat
  // Completions, without the effort, which not every model there takes.
  nebius: ({ model, key }) => INFER.openai({ endpoint: 'https://api.tokenfactory.nebius.com/v1', model, key }),
};

// Failures where the server most likely did no work, sent once more: busy
// or overloaded, or the connection refused or reset before any answer.
const BUSY = [429, 503, 529];
const DROPPED = ['ECONNREFUSED', 'ECONNRESET', 'UND_ERR_SOCKET'];

// POST `body` to `url` as JSON: the reply, or an error that says what failed
// and where to change it. A busy server or a dropped connection gets the same
// body once more, after its retry-after (at most 60 s) or 5 s; a request has
// no effect but its answer, so a repeat costs only tokens.
async function post(url, headers, body) {
  const request = { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify(body) };
  for (let again = true; ; again = false) {
    const response = await fetch(url, request).catch((error) => error);
    const failed = response instanceof Error;
    if (again && (failed ? DROPPED.includes(response.cause?.code) : BUSY.includes(response.status))) {
      const after = failed ? NaN : Number(response.headers.get('retry-after') ?? NaN);
      await new Promise((resolve) => setTimeout(resolve, (Number.isFinite(after) ? Math.min(after, 60) : 5) * 1000));
      continue;
    }
    if (failed) throw new Error(`Cannot reach ${url} (${response.cause?.code ?? response.message}).\n${SETTINGS}`);
    if (!response.ok) throw new Error([`${url}: ${response.status} ${await response.text()}`, HINTS[response.status], SETTINGS].filter(Boolean).join('\n'));
    return response.json();
  }
}

