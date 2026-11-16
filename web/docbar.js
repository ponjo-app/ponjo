// The doc's status bar, under the page for every view: on the left what the
// view says (the plain view's caret place) and the doc's word count, on the
// right the buddies' loop (src/host/runner.js, loop) with Pause or Resume,
// then the view's own buttons. The view fills its parts in (web/views/plain/status.js).

const RING_R = 6;
const RING = 2 * Math.PI * RING_R; // the loop's ring, round (app.css: .pj-loop-arc)
const SOON_MS = 3000; // a look this soon follows a change (src/host/runner.js)
const words = new Intl.Segmenter(undefined, { granularity: 'word' });

/** How many words `text` holds, in any script. */
export function wordCount(text) {
  let count = 0;
  for (const part of words.segment(text)) if (part.isWordLike) count++;
  return count;
}

// `ms` as m:ss.
const clock = (ms) => {
  const s = Math.ceil(ms / 1000);
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
};
const listed = (names) => (names.length > 1 ? `${names.slice(0, -1).join(', ')} and ${names.at(-1)}` : names[0]);

/**
 * The bar `bar` (index.html's `.pj-docbar`). `onPause(paused)` asks the host
 * to pause the loop or resume it; `canPause()` is whether this window may.
 * `setWords(text, selection)` counts the doc's words, and the selection's
 * ({ from, to }) when there is one; `setLoop(loop)` and `setAgents(statuses)`
 * repaint the loop, which is painted each second while it shows.
 */
export function createDocBar(bar, { onPause, canPause }) {
  const count = bar.querySelector('.pj-status-words');
  const loopPart = bar.querySelector('.pj-loop');
  const loopText = loopPart.querySelector('.pj-loop-text');
  const arc = loopPart.querySelector('.pj-loop-arc');
  const pause = bar.querySelector('.pj-loop-pause');
  let loop = { waiting: 0, paused: false, from: null, at: null };
  let agents = [];
  let total = 0;

  pause.addEventListener('click', () => onPause(!loop.paused));

  function paintLoop() {
    const working = agents.filter((a) => a.threadIds.length > 0);
    const shown = loop.paused || loop.waiting > 0;
    loopPart.hidden = !shown;
    pause.hidden = !shown || !canPause();
    if (!shown) return;
    const now = Date.now();
    let state = 'resting';
    let text;
    let filled = 0;
    if (working.length > 0) {
      state = 'working';
      text = `${listed(working.map((a) => a.name))} ${working.length === 1 ? 'is' : 'are'} working…`;
    } else if (loop.paused) {
      state = 'still';
      text = 'Paused';
    } else if (loop.at === null) {
      state = 'still';
      text = 'Next look when the doc changes';
    } else {
      filled = Math.min(1, Math.max(0, (now - loop.from) / (loop.at - loop.from)));
      text = loop.at - loop.from <= SOON_MS ? 'Looking soon' : `Next look in ${clock(loop.at - now)}`;
    }
    loopPart.dataset.state = state;
    loopText.textContent = text;
    arc.style.strokeDashoffset = String(RING * (1 - filled));
    pause.textContent = loop.paused ? 'Resume' : 'Pause';
    pause.dataset.tip = loop.paused ? 'Let the buddies look at the doc again' : 'Stop the buddies looking at the doc';
  }
  setInterval(paintLoop, 1000);

  return {
    setWords(text, selection) {
      total = wordCount(text);
      this.setSelection(text, selection);
    },
    /** Only the selection moved: the doc's count stands. */
    setSelection(text, selection) {
      const of = (n) => `${n.toLocaleString()} ${n === 1 ? 'word' : 'words'}`;
      const picked = selection && selection.from !== selection.to ? wordCount(text.slice(Math.min(selection.from, selection.to), Math.max(selection.from, selection.to))) : null;
      count.textContent = picked === null ? of(total) : `${picked.toLocaleString()} of ${of(total)}`;
    },
    setLoop(next) {
      loop = next ?? loop;
      paintLoop();
    },
    setAgents(next) {
      agents = next ?? [];
      paintLoop();
    },
  };
}
