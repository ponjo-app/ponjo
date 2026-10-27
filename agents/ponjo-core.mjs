// The Ponjo agent's turn (docs/ponjo-agent.md), with no I/O of its own:
// the tools, the loop, the check of a proposal and each provider's infer.
// Imports nothing, so it runs in Node, next to ponjo.mjs, and in a browser
// (preview/doc-stub.js). Yours to change.

const STEPS = 20;
const MAX_READ = 20_000; // characters a read without `lines` returns

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
    name: 'propose',
    description: 'End your turn: your edits and your reply. To edit the doc, replace `old`, quoted exactly from it and found there once, with `new`. To comment, append to the comments file: `old` empty, `new` the lines to append. No other file can change. `reply` is what you print, and may be empty. One bad edit sends the whole proposal back, saying what to fix.',
    parameters: {
      type: 'object',
      properties: {
        edits: {
          type: 'array',
          items: {
            type: 'object',
            properties: { path: { type: 'string' }, old: { type: 'string' }, new: { type: 'string' } },
            required: ['path', 'old', 'new'],
          },
        },
        reply: { type: 'string' },
      },
      required: ['edits', 'reply'],
    },
  },
];

/**
 * One buddy answering one thread: `prompt` is stdin as is, `doc` and
 * `sidecar` the copies' paths. `infer(messages, tools)` is one step of the
 * model (INFER) and resolves to { calls: [{ id, name, args }], sent }, `args`
 * the JSON the model wrote and `sent` its message as its API sent it;
 * `readFile(path)` to a file's text, a folder's entries or null; `resolve(path)`
 * a path the model wrote as the copies' paths are written (on disk,
 * node:path's resolve). Resolves to the checked { edits, reply }, and throws
 * when the turn fails.
 *
 * The messages are in one form for every provider: { role: 'user', content },
 * { role: 'assistant', calls, sent }, and { role: 'tool', id, content }, a
 * call's result.
 */
export async function turn({ prompt, doc, sidecar }, { infer, readFile, resolve = (path) => path }) {
  const messages = [{ role: 'user', content: prompt }];
  for (let step = 0; step < STEPS; step++) {
    const { calls, sent } = await infer(messages, TOOLS);
    messages.push({ role: 'assistant', calls, sent });
    const [call, ...more] = calls;
    if (!call) {
      messages.push({ role: 'user', content: 'Call read or propose.' });
      continue;
    }
    const result = await use(call, { doc, sidecar, readFile, resolve });
    if (typeof result !== 'string') return result;
    messages.push({ role: 'tool', id: call.id, content: result });
    for (const extra of more) messages.push({ role: 'tool', id: extra.id, content: 'Not run: one tool per step.' });
  }
  throw new Error(`No proposal in ${STEPS} steps.`);
}

// What a tool call gives back to the model, or a valid proposal's { edits, reply }.
async function use({ name, args: json }, { doc, sidecar, readFile, resolve }) {
  let args;
  try {
    args = JSON.parse(json);
  } catch {
    return `The arguments are not JSON: ${json}`;
  }
  if (name === 'read') return read(args, readFile);
  if (name !== 'propose') return `No tool ${name}: call read or propose.`;
  const { edits, reply = '' } = args;
  if (!Array.isArray(edits) || typeof reply !== 'string') return 'propose takes { edits: [{ path, old, new }], reply }.';
  try {
    apply(edits, { doc, sidecar }, { doc: await readFile(doc), sidecar: await readFile(sidecar) }, resolve);
  } catch (error) {
    return `Nothing was changed. ${error.message}`;
  }
  return { edits, reply };
}

async function read({ path, lines }, readFile) {
  const found = typeof path === 'string' ? await readFile(path) : null;
  if (found === null) return `${path}: no such file, or not one you can read.`;
  if (Array.isArray(found)) return found.join('\n') || '(an empty folder)';
  const all = found.replace(/\r?\n$/, '').split(/\r?\n/);
  if (!lines && found.length > MAX_READ) return outline(path, all);
  const from = Math.max(1, lines?.[0] ?? 1);
  return all.slice(from - 1, lines?.[1] ?? all.length).map((line, i) => `${from + i}\t${line}`).join('\n');
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
 * current Claude models refuse a forced tool call, and a reply without one is
 * sent back anyway.
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
    return { calls, sent: reply.content };
  },
  // The Chat Completions API, which OpenAI, OpenRouter and others speak.
  openai: ({ endpoint, model, key, effort }, url = endpoint.replace(/\/+$/, '')) => async (messages, tools) => {
    const { choices: [{ message }] } = await post(`${url}/chat/completions`, { authorization: `Bearer ${key}` }, {
      model,
      reasoning_effort: effort,
      tool_choice: 'auto',
      tools: tools.map((tool) => ({ type: 'function', function: tool })),
      messages: messages.map((m) => (m.role === 'assistant' ? m.sent : m.role === 'tool' ? { role: 'tool', tool_call_id: m.id, content: m.content } : m)),
    });
    const calls = (message.tool_calls ?? []).map(({ id, function: { name, arguments: args } }) => ({ id, name, args }));
    return { calls, sent: message };
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

