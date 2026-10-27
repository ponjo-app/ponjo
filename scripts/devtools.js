// Drive an Electron app over the DevTools protocol, the one port it opens:
// the desktop smoke test (scripts/smoke-desktop.js) and the view contract
// tests (test/views.test.js).

import { spawn } from 'node:child_process';

/**
 * Start Electron app `exe` with `args`, the DevTools protocol on a port it
 * picks. Its pages' console messages and errors go to its stderr too
 * (--enable-logging), so a window that did not show can say why; each
 * of its lines goes to `onLine` as well.
 */
export async function launchElectron(exe, args, { env, onLine = () => {} }) {
  const child = spawn(exe, [...args, '--remote-debugging-port=0', '--enable-logging'], { env, stdio: ['ignore', 'ignore', 'pipe'] });
  const exited = new Promise((done) => child.once('exit', done));
  let stderr = ''; // its last lines, to say why a window did not show
  let partial = '';
  child.stderr.on('data', (chunk) => {
    const lines = (partial + chunk).split(/\r?\n/);
    partial = lines.pop();
    lines.forEach(onLine);
  });
  const devtoolsPort = await new Promise((done, fail) => {
    const timer = setTimeout(() => fail(new Error('the app did not start')), 30_000);
    child.stderr.on('data', (chunk) => {
      stderr = (stderr + chunk).slice(-8000);
      const found = stderr.match(/DevTools listening on ws:\/\/127\.0\.0\.1:(\d+)\//);
      if (found) {
        clearTimeout(timer);
        done(Number(found[1]));
      }
    });
  });
  const base = `http://127.0.0.1:${devtoolsPort}`;
  return {
    pid: child.pid,
    devtoolsPort,
    // The page whose title starts with `name`, once there, within `ms`;
    // if it is not, the error says what each page there shows and the app's stderr.
    async page(name, ms = 30_000) {
      const pages = async () => (await (await fetch(`${base}/json`)).json()).filter((t) => t.type === 'page');
      const target = await waitFor(async () => (await pages()).find((t) => t.title.startsWith(name)), ms, `the ${name} window`)
        .catch(async (error) => {
          const shown = await pages().then((all) => Promise.all(all.map(describe)), () => ['DevTools did not answer']);
          throw new Error(`${error.message}\npages:\n${shown.join('\n') || 'none'}\nthe app's stderr, last lines:\n${stderr}`);
        });
      const cdp = await connect(target.webSocketDebuggerUrl);
      return {
        send: (method, params) => cdp.send(method, params),
        async evaluate(expression) {
          const res = await cdp.send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
          if (res.result?.exceptionDetails) throw new Error(res.result.exceptionDetails.text);
          return res.result?.result?.value;
        },
      };
    },
    async quit() {
      const { webSocketDebuggerUrl } = await (await fetch(`${base}/json/version`)).json();
      const browser = await connect(webSocketDebuggerUrl);
      browser.send('Browser.close').catch(() => {});
      const code = await Promise.race([exited, new Promise((done) => setTimeout(() => done('timeout'), 15_000))]);
      if (code === 'timeout') {
        child.kill();
        throw new Error('the app did not quit');
      }
    },
  };
}

export async function waitFor(probe, ms, what) {
  const deadline = Date.now() + ms;
  for (;;) {
    try {
      const value = await probe();
      if (value) return value;
    } catch {
      // not up yet
    }
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await new Promise((done) => setTimeout(done, 250));
  }
}

// What page `target` shows: its title, file, whether it has the app's
// line to its doc (window.ponjoHost, from the preload) and its first text.
async function describe(target) {
  const look = `JSON.stringify({ file: location.pathname.split('/').at(-1), ready: document.readyState, host: Boolean(window.ponjoHost), text: (document.body?.innerText ?? '').slice(0, 200) })`;
  const seen = await Promise.race([
    connect(target.webSocketDebuggerUrl).then((cdp) => cdp.send('Runtime.evaluate', { expression: look, returnByValue: true })),
    new Promise((done) => setTimeout(done, 2000)),
  ]).catch(() => null);
  return `  ${JSON.stringify(target.title)}: ${seen?.result?.result?.value ?? 'did not answer'}`;
}

async function connect(url) {
  const ws = new WebSocket(url);
  await new Promise((done, fail) => {
    ws.onopen = done;
    ws.onerror = fail;
  });
  let id = 0;
  const pending = new Map();
  ws.onmessage = (event) => {
    const message = JSON.parse(event.data);
    pending.get(message.id)?.(message);
    pending.delete(message.id);
  };
  return {
    send(method, params = {}) {
      return new Promise((done) => {
        const n = ++id;
        pending.set(n, done);
        ws.send(JSON.stringify({ id: n, method, params }));
      });
    },
  };
}
