// The Ponjo agent's turn (docs/ponjo-agent.md), with no I/O of its own:
// the tools, the loop, the check of a proposal and each provider's infer.
// Imports nothing, so it runs in Node, next to ponjo.mjs, and in a browser
// (preview/doc-stub.js). Yours to change.

const STEPS = 20;
const MAX_READ = 20_000; // characters a read without `lines` returns
const MAX_FOUND = 100; // paths find, or lines grep, gives before it asks to narrow
const MAX_LINE = 500; // characters of a line grep shows
const ANY_TOOL = 'read, find, grep, comment, resolve or propose';
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
    description: 'Start a new thread in the doc, as a member does, for a member to decide something: never a mark in the doc itself. It is added when your turn ends, with your edits.',
    parameters: {
      type: 'object',
      properties: {
        on: { type: 'string', description: 'The text it is about, quoted exactly from the doc and found there once; "" for the whole doc.' },
        body: { type: 'string', description: 'What the member must decide.' },
      },
      required: ['on', 'body'],
    },
  },
  {
    name: 'resolve',
    description: 'Resolve the thread you are answering, when your turn ends: only when its last comment asks you to close or resolve it. Doing what it asked is no reason to.',
    parameters: { type: 'object', properties: {} },
  },
  {
    name: 'propose',
    description: 'End your turn: your edits of the doc and your reply. Each edit replaces `old`, quoted exactly from the doc and found there once, with `new`; no other file can change, and comments are the comment tool\'s. `reply` is what you print, your answer in this thread, and may be empty. One bad edit sends the whole proposal back, saying what to fix.',
    parameters: {
      type: 'object',
      properties: {
        edits: { type: 'array', items: { type: 'object', properties: { old: { type: 'string' }, new: { type: 'string' } }, required: ['old', 'new'] } },
        reply: { type: 'string' },
      },
      required: ['edits', 'reply'],
    },
  },
];

/**
 * One buddy answering one thread, `thread` (its id): `prompt` is stdin as
 * is, `doc` and `sidecar` the copies' paths in the project. `infer(messages, tools)` is one step of the
 * model (INFER) and resolves to { calls: [{ id, name, args }], text, sent, usage },
 * `args` the JSON the model wrote, `text` what it wrote besides, `sent` its
 * message as its API sent it and `usage` the tokens it took, as the API
 * counts them; `readFile(path)` to a file's text, a folder's entries (a
 * subfolder's ending in /) or null;
 * `resolve(path)` a path the model wrote as the copies' paths are written
 * (ponjo.mjs's inProject). Resolves to the checked { edits, reply }, `edits`
 * the doc's and the sidecar's lines from comment and resolve, as `apply`
 * takes them, and throws when the turn fails.
 *
 * The messages are in one form for every provider: { role: 'user', content },
 * { role: 'assistant', calls, sent }, and { role: 'tool', id, content }, a
 * call's result. Each call of a step runs, in order.
 */
export async function turn({ prompt, doc, sidecar, thread }, { infer, readFile, resolve = (path) => path }) {
  const messages = [{ role: 'user', content: prompt }];
  const lines = []; // the sidecar's, from comment and resolve, added with the proposal
  const added = () => (lines.length ? [{ path: sidecar, old: '', new: lines.join('\n') }] : []);
  for (let step = 0; step < STEPS; step++) {
    const { calls, text, sent } = await infer(messages, TOOLS);
    messages.push({ role: 'assistant', calls, sent });
    if (!calls.length) return { edits: added(), reply: text.trim() }; // an answer without a call, as any agent's
    for (const call of calls) {
      const result = await use(call, { doc, sidecar, thread, lines, added, readFile, resolve });
      if (typeof result !== 'string') return result;
      messages.push({ role: 'tool', id: call.id, content: result });
    }
  }
  throw new Error(`No proposal in ${STEPS} steps.`);
}

// What a tool call gives back to the model, or a valid proposal's { edits, reply }.
async function use({ name, args: json }, { doc, sidecar, thread, lines, added, readFile, resolve }) {
  let args;
  try {
    args = JSON.parse(json);
  } catch {
    return `The arguments are not JSON: ${json}`;
  }
  if (name === 'read') return read(args, readFile);
  if (name === 'find' || name === 'grep') return search(name, args, readFile, resolve);
  if (name === 'comment') {
    const { on, body } = args;
    if (typeof on !== 'string' || typeof body !== 'string' || !body.trim()) return 'Not added: comment takes { on, body }, body not empty.';
    const text = (await readFile(doc)).replace(/\r\n/g, '\n');
    const found = on && text.split(on.replace(/\r\n/g, '\n'));
    if (found && found.length !== 2) return `Not added: on is ${found.length < 2 ? 'not in the doc: quote it exactly' : 'in the doc more than once: quote more of it'}, or give "" for the whole doc.`;
    lines.push(JSON.stringify(on ? { anchor: { exact: on }, body } : { body }));
    return on ? `Added when your turn ends, on line ${found[0].split('\n').length}.` : 'Added when your turn ends, on the whole doc.';
  }
  if (name === 'resolve') {
    const line = JSON.stringify({ thread, resolved: true });
    if (!lines.includes(line)) lines.push(line);
    return 'This thread is resolved when your turn ends.';
  }
  if (name !== 'propose') return `No tool ${name}: call ${ANY_TOOL}.`;
  const { edits, reply = '' } = args;
  if (!Array.isArray(edits) || typeof reply !== 'string') return 'propose takes { edits: [{ old, new }], reply }.';
  const off = edits.find((edit) => edit?.path !== undefined && resolve(edit.path) !== doc);
  if (off) return `Nothing was changed. ${off.path} cannot change: edits change only ${doc}, and comments are the comment tool's.`;
  const all = [...edits.map((edit) => ({ ...edit, path: doc })), ...added()];
  try {
    apply(all, { doc, sidecar }, { doc: await readFile(doc), sidecar: await readFile(sidecar) }, resolve);
  } catch (error) {
    return `Nothing was changed. ${error.message}`;
  }
  return { edits: all, reply };
}

async function read({ path, lines }, readFile) {
  const found = typeof path === 'string' ? await readFile(path) : null;
  if (found === null) return `${path}: no such file, or not one you can read.`;
  if (Array.isArray(found)) return found.join('\n') || '(an empty folder)';
  const all = linesOf(found);
  if (!lines && found.length > MAX_READ) return outline(path, all);
  const from = Math.max(1, lines?.[0] ?? 1);
  return all.slice(from - 1, lines?.[1] ?? all.length).map((line, i) => `${from + i}\t${line}`).join('\n');
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
// folder and its subfolders; null when there is none.
async function under(path, readFile) {
  const found = await readFile(path);
  if (!Array.isArray(found)) return found === null ? null : [path];
  const paths = [];
  for (const entry of found) {
    const at = path === '' || path === '.' ? entry : `${path.replace(/\/$/, '')}/${entry}`;
    paths.push(...(entry.endsWith('/') ? (await under(at.slice(0, -1), readFile)) ?? [] : [at]));
  }
  return paths;
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

// A sidecar line the app takes (docs/agent-config.md#comments).
const isComment = (line) => {
  try {
    const c = JSON.parse(line);
    if (Object.keys(c).sort().join() === 'resolved,thread') return c.resolved === true && typeof c.thread === 'string';
    return ['body', 'anchor,body', 'body,thread'].includes(Object.keys(c).sort().join()) && typeof c.body === 'string'
      && (!('anchor' in c) || typeof c.anchor?.exact === 'string') && (!('thread' in c) || typeof c.thread === 'string');
  } catch {
    return false;
  }
};

/**
 * The copies' texts { doc, sidecar } after `edits`, all or none: throws what
 * to fix. `paths` are the copies' paths, `resolve` as for `turn`.
 */
export function apply(edits, paths, texts, resolve = (path) => path) {
  // read shows a CRLF doc's lines without their \r: a quote and its edit get them back.
  const eol = (text) => (texts.doc.includes('\r\n') ? text.replace(/\r?\n/g, '\r\n') : text);
  const spans = [];
  const appended = [];
  for (const [i, edit] of edits.entries()) {
    const which = `Edit ${i + 1}`;
    if (!['path', 'old', 'new'].every((key) => typeof edit?.[key] === 'string')) throw new Error(`${which}: path, old and new must be strings.`);
    const { path, old, new: by } = edit;
    if (resolve(path) === paths.sidecar) {
      if (old) throw new Error(`${which}: on ${paths.sidecar}, old must be empty: new is appended.`);
      const lines = by.split('\n').filter((line) => line.trim());
      const bad = lines.find((line) => !isComment(line));
      if (bad) throw new Error(`${which}: not a comment line: ${bad}. Each line is {"anchor":{"exact":"…"},"body":"…"}, {"body":"…"}, {"thread":"c_…","body":"…"} or {"thread":"c_…","resolved":true}.`);
      appended.push(...lines);
    } else if (resolve(path) === paths.doc) {
      const quote = eol(old);
      const start = quote ? texts.doc.indexOf(quote) : -1;
      if (start < 0) throw new Error(`${which}: old ${old ? 'is not in the doc: read it and quote it exactly' : 'is empty: quote the text to replace'}.`);
      if (texts.doc.includes(quote, start + 1)) throw new Error(`${which}: old is in the doc more than once: quote more of it.`);
      spans.push({ start, end: start + quote.length, by: eol(by), which });
    } else {
      throw new Error(`${which}: ${path} cannot change: only ${paths.doc} and ${paths.sidecar} can.`);
    }
  }
  spans.sort((a, b) => a.start - b.start);
  let doc = '';
  let at = 0;
  for (const { start, end, by, which } of spans) {
    if (start < at) throw new Error(`${which} overlaps another edit: make them one.`);
    doc += texts.doc.slice(at, start) + by;
    at = end;
  }
  const sidecar = texts.sidecar;
  const tail = appended.length ? `${sidecar && !sidecar.endsWith('\n') ? '\n' : ''}${appended.join('\n')}\n` : '';
  return { doc: doc + texts.doc.slice(at), sidecar: sidecar + tail };
}

// Where a failed run's reply sends the user: the failure, then what to change.
const SETTINGS = 'The provider, endpoint, model and key are in Settings > Agents > Ponjo agent.';
const HINTS = { 401: 'Check the API key.', 404: 'Check the endpoint and the model.' };

const CACHED = { type: 'ephemeral' };

/**
 * One step of the model, by provider: `INFER[provider](settings, url)` is
 * `infer` for `turn`, over that provider's API at `url`. `settings` are the
 * agent's: { endpoint, model, key, effort }. Each sends `tool_choice: auto`:
 * current Claude models refuse a forced tool call, and an answer without one
 * is the reply.
 */
export const INFER = {
  // Anthropic's Messages API. The model thinks as it needs, at `effort`; its
  // messages go back as they came, thinking included. The tools and the
  // prompt are cached for the turn's later steps.
  anthropic: ({ model, key, effort }, url = 'https://api.anthropic.com/v1') => async (messages, tools) => {
    const reply = await post(`${url}/messages`, { 'x-api-key': key, 'anthropic-version': '2023-06-01' }, {
      model,
      max_tokens: 16_000,
      output_config: { effort },
      tool_choice: { type: 'auto' },
      tools: tools.map(({ name, description, parameters }, i) => ({ name, description, input_schema: parameters, ...(i === tools.length - 1 && { cache_control: CACHED }) })),
      messages: messages.map((m, i) => {
        if (m.role === 'assistant') return { role: 'assistant', content: m.sent };
        if (m.role === 'tool') return { role: 'user', content: [{ type: 'tool_result', tool_use_id: m.id, content: m.content }] };
        return { role: 'user', content: [{ type: 'text', text: m.content, ...(i === 0 && { cache_control: CACHED }) }] };
      }),
    });
    if (reply.stop_reason === 'refusal') throw new Error(`The model refused: ${reply.stop_details?.explanation ?? 'no reason given.'}`);
    if (reply.stop_reason === 'max_tokens') throw new Error('The model\'s answer was cut off at 16,000 tokens.');
    const calls = reply.content.filter((block) => block.type === 'tool_use').map(({ id, name, input }) => ({ id, name, args: JSON.stringify(input) }));
    const text = reply.content.filter((block) => block.type === 'text').map((block) => block.text).join('');
    return { calls, text, sent: reply.content, usage: reply.usage };
  },
  // The Chat Completions API, which OpenAI, OpenRouter and others speak.
  openai: ({ endpoint, model, key, effort }, url = endpoint.replace(/\/+$/, '')) => async (messages, tools) => {
    const { choices: [{ message }], usage } = await post(`${url}/chat/completions`, { authorization: `Bearer ${key}` }, {
      model,
      reasoning_effort: effort,
      tool_choice: 'auto',
      tools: tools.map((tool) => ({ type: 'function', function: tool })),
      messages: messages.map((m) => (m.role === 'assistant' ? m.sent : m.role === 'tool' ? { role: 'tool', tool_call_id: m.id, content: m.content } : m)),
    });
    const calls = (message.tool_calls ?? []).map(({ id, function: { name, arguments: args } }) => ({ id, name, args }));
    return { calls, text: message.content ?? '', sent: message, usage };
  },
  // Nebius Token Factory, where NVIDIA's Nemotron models run: Chat
  // Completions, without the effort, which not every model there takes.
  nebius: ({ model, key }) => INFER.openai({ endpoint: 'https://api.tokenfactory.nebius.com/v1', model, key }),
};

// POST `body` to `url` as JSON: the reply, or an error that says what failed and where to change it.
async function post(url, headers, body) {
  const response = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify(body) }).catch((error) => {
    throw new Error(`Cannot reach ${url} (${error.cause?.code ?? error.message}).\n${SETTINGS}`);
  });
  if (!response.ok) throw new Error([`${url}: ${response.status} ${await response.text()}`, HINTS[response.status], SETTINGS].filter(Boolean).join('\n'));
  return response.json();
}

