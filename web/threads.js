// The comment margin, Google Docs style: one card per thread beside the text it
// is about, stacked so they never overlap. A thread not open is folded to its
// first comment and a line on what followed; the open one is whole and sits
// at its text, the others giving way. The threads with no place in the text
// are one comment icon at the top, opened in place. A buddy shows up like
// any other collaborator: an avatar, its replies, and its face at work while
// it works. A reply whose run failed, or whose edit was partly dropped for
// the human's text, says so; one that
// edited the doc on this machine shows its edits in the text and offers
// Undo, and once undone, Redo; one whose run left a trace links to it. Only
// people resolve and reopen threads.

import { icon } from './icons.js';
import { agentFace, buddyColor, nameOf, personFace } from './faces.js';
import { mentionSpans } from '../src/core/mentions.js';

const GAP = 10;
const MENTION_BEFORE_CARET = /(^|[^A-Za-z0-9._-])@([A-Za-z0-9._-]*)$/;

/**
 * @param {HTMLElement} margin
 * @param {{ onCreate: (body: string) => Promise<void>, onCancelDraft: () => void,
 *           onReply: (threadId: string, body: string) => Promise<void>,
 *           onResolve: (threadId: string) => Promise<void>, onReopen: (threadId: string) => Promise<void>,
 *           onUndo: (replyId: string) => Promise<void>, onRedo: (replyId: string) => Promise<void>,
 *           onShowEdits: (replyId: string | null) => void,
 *           onSelect: (threadId: string | null) => void, onHover: (threadId: string | null) => void,
 *           anchorTops: (items: { id: string, anchor: object }[]) => Map<string, number>,
 *           mentionChoices?: (query: string, me: string) => { id?, name, kind, group, tagline? }[],
 *           mentionable?: () => { id?: string, name: string, kind: string }[],
 *           traceOf?: (replyId: string) => string | undefined, onTrace?: (run: string) => void }} handlers
 */
export function createCommentMargin(margin, handlers) {
  let threads = [];
  let agents = []; // the buddies' statuses in this doc: who works on which threads
  let me = { id: null, name: '' };
  let edits = {}; // the buddy replies that edited the doc here: { [id]: { state: 'edited' | 'undone', ... } }
  let shownEdits = null; // the reply whose edits the text shows
  let activeId = null;
  let draft = null; // { anchor } while composing a comment on the selected text
  let showResolved = false;
  let asideOpen = false; // the threads with no place in the text, opened at the top
  const replyDrafts = new Map();
  const unfolded = new Set(); // ids of long comments shown in full
  const narrow = window.matchMedia('(max-width: 900px)');

  // ---- rendering ----

  function visibleThreads() {
    return threads.filter((t) => t.resolved === showResolved);
  }

  // Cards beside their text: not in the list of resolved ones, nor in a narrow window's sheet.
  const beside = () => !showResolved && !narrow.matches;
  // A thread with no place in the text: on the whole doc, or its text deleted.
  const unplaced = (thread) => !thread.anchor || thread.detached;

  function render() {
    const focused = document.activeElement?.closest?.('[data-box]')?.dataset.box;
    const caret = document.activeElement?.selectionStart;

    margin.classList.toggle('pj-margin-list', showResolved);
    const cards = [];
    if (draft) cards.push(draftCard());
    const shown = visibleThreads();
    const aside = beside() ? shown.filter(unplaced) : [];
    if (aside.length > 0) {
      cards.push(unplacedButton(aside));
      if (asideOpen) for (const thread of aside) cards.push(threadCard(thread));
    }
    for (const thread of shown) {
      if (!aside.includes(thread)) cards.push(thread.id === activeId ? threadCard(thread) : foldedCard(thread));
    }
    if (showResolved && shown.length === 0) cards.push(el('p', 'pj-empty', 'No resolved comments.'));

    // Live updates arrive while the human types: keep the card they are typing
    // in attached, updated around its text box, so text, caret and IME input survive.
    const typingIn = focused && document.activeElement.closest('.pj-card');
    const at = typingIn ? cards.findIndex((c) => c.dataset.thread === typingIn.dataset.thread) : -1;
    const kept = at !== -1 && patchCard(typingIn, cards[at]) ? typingIn : null;
    if (kept) cards[at] = kept;
    for (const child of [...margin.children]) if (child !== kept) child.remove();
    cards.forEach((card, i) => {
      if (kept && i < at) margin.insertBefore(card, kept);
      else if (card !== kept) margin.append(card);
    });

    if (focused && !kept) {
      const box = margin.querySelector(`[data-box="${focused}"] textarea`);
      if (box) {
        box.focus();
        if (caret !== undefined && caret !== null) box.setSelectionRange(caret, caret);
      }
    }
    layout();
  }

  // A thread whole: every comment, what its runs did, and the reply box when it is open.
  function threadCard(thread) {
    const card = cardFor(thread, 'pj-card');
    const active = thread.id === activeId;
    const working = workingOn(thread);
    card.classList.toggle('pj-card-active', active);
    card.classList.toggle('pj-card-aside', beside() && unplaced(thread));

    if (thread.anchor && thread.detached) card.append(el('div', 'pj-card-note', 'The text this was about was deleted.'));
    if (thread.anchor && (showResolved || thread.detached)) card.append(quote(thread));
    if (!thread.anchor) card.append(el('div', 'pj-card-note', 'On the whole document'));

    commentsOf(thread).forEach((comment, i) => {
      card.append(commentRow(comment, i === 0 && !thread.resolved ? resolveButton(thread) : null));
    });

    // Each buddy working on it, its face at work; several can at once.
    for (const { id, name } of working) {
      const row = el('div', 'pj-typing');
      row.append(avatar(name, 'agent', true, id), el('span', '', `${name} is working…`));
      card.append(row);
    }
    if (thread.resolved) {
      const by = thread.comments.findLast((c) => c.resolved).by;
      const row = el('div', 'pj-resolved-row');
      row.append(checkIcon(), el('span', '', `Resolved by ${by.id === me.id ? 'you' : by.name}`));
      row.append(linkButton('Reopen', () => handlers.onReopen(thread.id)));
      card.append(row);
    }
    if (active && !thread.resolved) card.append(composer(`reply:${thread.id}`, 'Reply…', 'Reply', async (body) => {
      await handlers.onReply(thread.id, body);
      replyDrafts.delete(thread.id);
    }, () => handlers.onSelect(null), thread.id));
    return card;
  }

  // A thread folded: its first comment, cut to two lines, and one line on
  // what followed: the buddies at work on it, a run that failed, or who
  // replied, the edits they made and when.
  function foldedCard(thread) {
    const card = cardFor(thread, 'pj-card pj-card-folded');
    if (!thread.anchor) card.append(el('div', 'pj-card-note', 'On the whole document'));
    else if (showResolved || thread.detached) card.append(quote(thread));
    const [first, ...replies] = commentsOf(thread);
    const body = el('div', 'pj-body');
    body.append(...withMentions(first.body, handlers.mentionable?.() ?? [], handlers.files?.(), handlers.openFile));
    card.append(messageHead(first, thread.resolved ? null : resolveButton(thread)), body);
    const foot = footOf(thread, replies);
    if (foot) card.append(foot);
    return card;
  }

  function footOf(thread, replies) {
    const working = workingOn(thread);
    const last = replies.at(-1);
    const foot = el('div', 'pj-foot');
    const faces = (people) => {
      const row = el('span', 'pj-foot-faces');
      for (const { id, name, kind } of people) row.append(avatar(name, kind, true, id));
      return row;
    };
    const dot = () => el('span', 'pj-foot-dot', '·');
    if (working.length > 0) {
      foot.classList.add('pj-foot-working');
      foot.append(faces(working.map(({ id, name }) => ({ id, name, kind: 'agent' }))), el('span', '', `${listed(working.map((a) => a.name))} ${working.length === 1 ? 'is' : 'are'} working…`));
    } else if (last?.failed) {
      foot.classList.add('pj-foot-failed');
      foot.append(el('span', '', `${nameOf(last.by.id, last.by.name)}'s run failed`), dot(), el('time', '', relativeTime(last.at)));
    } else if (last) {
      const who = [...new Map(replies.map((c) => [c.by.id, { id: c.by.id, name: kindOf(c) === 'agent' ? nameOf(c.by.id, c.by.name) : c.by.name, kind: kindOf(c) }])).values()];
      const changes = replies.reduce((n, c) => n + (edits[c.id]?.state === 'edited' ? edits[c.id].changes : 0), 0);
      foot.append(faces(who.slice(0, 3)), el('span', '', `${replies.length} ${replies.length === 1 ? 'reply' : 'replies'}`));
      if (changes > 0) foot.append(dot(), el('span', '', `${changes} ${changes === 1 ? 'edit' : 'edits'}`));
      foot.append(dot(), el('time', '', relativeTime(last.at)));
    } else return null;
    return foot;
  }

  // The threads with no place in the text, as one: the comment icon and how
  // many. Opened, they are whole at the top of the margin, over the cards
  // there; selecting another thread, or clicking the doc, closes them.
  function unplacedButton(list) {
    const button = el('button', 'pj-unplaced');
    button.type = 'button';
    const whole = list.filter((t) => !t.anchor).length;
    const gone = list.length - whole;
    button.title = [whole && `${whole} on the whole document`, gone && `${gone} whose text was deleted`].filter(Boolean).join(', ');
    button.setAttribute('aria-label', button.title);
    button.setAttribute('aria-expanded', String(asideOpen));
    const busy = list.flatMap(workingOn)[0];
    if (busy) {
      button.classList.add('pj-unplaced-working');
      button.style.setProperty('--buddy', buddyColor(busy.id));
    }
    button.classList.toggle('pj-unplaced-failed', list.some((t) => commentsOf(t).at(-1)?.failed));
    button.append(icon('comments'), el('span', '', String(list.length)));
    button.addEventListener('click', () => {
      if (activeId) handlers.onSelect(null);
      asideOpen = true;
      render();
    });
    return button;
  }

  // A thread's card, which a click selects; a click that ends selecting its
  // text leaves the selection, to copy.
  function cardFor(thread, className) {
    const card = el('article', className);
    card.dataset.thread = thread.id;
    card.classList.toggle('pj-card-resolved', thread.resolved);
    card.addEventListener('click', (event) => {
      if (!event.target.closest('textarea, button, a') && getSelection().isCollapsed) handlers.onSelect(thread.id);
    });
    return card;
  }

  // The deleted text a thread was about, struck through, or the text of a resolved one.
  function quote(thread) {
    return el('blockquote', `pj-quote${thread.detached ? ' pj-quote-gone' : ''}`, truncate(thread.anchor.exact, 120));
  }

  // The buddies at work on a thread not resolved.
  const workingOn = (thread) => (thread.resolved ? [] : agents.filter((a) => a.threadIds.includes(thread.id)));

  // What a thread shows: a comment that only resolved it shows as the
  // resolved line; a buddy's reply with nothing to say still shows, for what
  // its run did.
  const commentsOf = (thread) => thread.comments.filter((c) => c.body.trim() !== '' || (c.by.kind === 'ai' && !c.resolved));

  function messageHead(comment, action) {
    const head = el('div', 'pj-msg-head');
    const who = el('div', 'pj-who');
    const kind = kindOf(comment);
    const shown = kind === 'agent' ? nameOf(comment.by.id, comment.by.name) : comment.by.name; // a buddy by its name now
    const name = el('span', 'pj-name', shown);
    who.append(name, el('time', 'pj-time', relativeTime(comment.at)));
    namecardFor(name, shown, kind, 'click');
    head.append(namecardFor(avatar(shown, kind, false, comment.by.id), shown, kind, 'click'), who);
    const run = handlers.traceOf?.(comment.id);
    if (run) head.append(linkButton('Trace', () => handlers.onTrace(run)));
    if (action) head.append(action);
    return head;
  }

  function commentRow(comment, action) {
    const row = el('div', 'pj-msg');
    const head = messageHead(comment, action);
    const shown = head.querySelector('.pj-name').textContent;
    const open = unfolded.has(comment.id);
    const body = el('div', `pj-body${open ? '' : ' pj-body-folded'}`);
    body.append(...withMentions(comment.body, handlers.mentionable?.() ?? [], handlers.files?.(), handlers.openFile));
    if (comment.body.trim()) row.append(head, body, foldButton(comment.id, open));
    else row.append(head);
    // To retry, or to redo what was dropped, the human asks again.
    if (comment.failed) row.append(el('div', 'pj-card-note pj-msg-note', `The run failed. @mention ${shown} again to retry.`));
    if (edits[comment.id]?.conflict) row.append(el('div', 'pj-card-note pj-msg-note', `People changed some of the same lines while it worked, twice, so its edit there was not applied. @mention ${shown} again to redo it.`));
    if (edits[comment.id]) row.append(receipt(comment.id, edits[comment.id]));
    row.classList.toggle('pj-msg-failed', Boolean(comment.failed));
    return row;
  }

  // What a run did, as the app counted it, on the machine that ran it:
  // the count shows its edits in the text, or hides them; the icon undoes
  // them, and once they are undone, redoes them.
  function receipt(id, { state, by, changes }) {
    const box = el('div', `pj-receipt${state === 'undone' ? ' pj-receipt-undone' : ''}`);
    box.style.setProperty('--buddy', buddyColor(by ?? ''));
    const them = changes === 1 ? 'this edit' : `these ${changes} edits`;
    if (state === 'undone') {
      box.append(icon('pencil'), el('span', '', `${changes === 1 ? 'Edit' : 'Edits'} undone`));
      box.append(receiptButton('redo', `Redo ${them}`, () => handlers.onRedo(id)));
    } else {
      const show = el('button', 'pj-receipt-show');
      show.type = 'button';
      show.setAttribute('aria-pressed', String(shownEdits === id));
      show.title = shownEdits === id ? 'Hide in the text' : 'Show in the text';
      show.append(icon('pencil'), el('span', '', `${changes} ${changes === 1 ? 'edit' : 'edits'}`));
      show.addEventListener('click', (event) => {
        event.stopPropagation();
        handlers.onShowEdits(shownEdits === id ? null : id);
      });
      box.append(show, receiptButton('undo', `Undo ${them}`, () => handlers.onUndo(id)));
    }
    return box;
  }

  // A receipt's Undo or Redo: off while the doc host does it, on again if it cannot.
  function receiptButton(name, title, act) {
    const button = el('button', `pj-icon-btn pj-receipt-${name}`);
    button.type = 'button';
    button.title = title;
    button.setAttribute('aria-label', title);
    button.append(icon(name));
    button.addEventListener('click', (event) => {
      event.stopPropagation();
      button.disabled = true;
      act().catch(() => { button.disabled = false; });
    });
    return button;
  }

  // Show more / Show less under a long message. Folded, it stays hidden until
  // layout finds the text actually overflows its clamp.
  function foldButton(id, open) {
    const button = el('button', 'pj-fold');
    button.type = 'button';
    button.setAttribute('aria-expanded', String(open));
    button.append(el('span', '', open ? 'Show less' : 'Show more'), icon('chevron'));
    button.hidden = !open;
    button.addEventListener('click', () => {
      if (open) unfolded.delete(id);
      else unfolded.add(id);
      render();
    });
    return button;
  }

  function resolveButton(thread) {
    const button = el('button', 'pj-icon-btn pj-resolve');
    button.type = 'button';
    button.title = 'Mark as resolved and hide';
    button.setAttribute('aria-label', 'Resolve');
    button.append(checkIcon());
    button.addEventListener('click', () => handlers.onResolve(thread.id));
    return button;
  }

  function draftCard() {
    const card = el('article', 'pj-card pj-card-active pj-card-draft');
    card.dataset.thread = 'draft';
    const head = el('div', 'pj-msg-head');
    const who = el('div', 'pj-who');
    who.append(el('span', 'pj-name', me.name));
    head.append(avatar(me.name, 'human', false, me.id), who);
    card.append(head);
    card.append(composer('draft', 'Comment…', 'Comment', async (body) => {
      await handlers.onCreate(body);
      draft = null;
      replyDrafts.delete('draft');
      render();
    }, () => {
      draft = null;
      replyDrafts.delete('draft');
      handlers.onCancelDraft();
      render();
    }, 'draft'));
    return card;
  }

  // A growing text box: Enter posts, Shift+Enter breaks the line, Escape
  // cancels. @ offers the agents and people to address, grouped (agents in
  // the doc, agents to bring in, people).
  function composer(id, placeholder, submitLabel, submit, cancel, draftKey) {
    const wrap = el('div', 'pj-composer');
    wrap.dataset.box = id;
    const box = document.createElement('textarea');
    box.rows = 1;
    box.placeholder = placeholder;
    box.value = draftKey ? replyDrafts.get(draftKey) ?? '' : '';
    const menu = el('ul', 'pj-mentions');
    menu.setAttribute('role', 'listbox');
    menu.hidden = true;
    const buttons = el('div', 'pj-composer-buttons');
    const send = el('button', 'pj-primary', submitLabel);
    send.type = 'button';
    const cancelButton = el('button', 'pj-secondary', 'Cancel');
    cancelButton.type = 'button';
    buttons.append(send, cancelButton);
    let choices = [];
    let selected = 0;

    const grow = () => {
      box.style.height = 'auto';
      box.style.height = `${box.scrollHeight}px`;
      send.disabled = !box.value.trim();
    };
    const update = () => {
      if (draftKey) replyDrafts.set(draftKey, box.value);
      grow();
      const match = box.value.slice(0, box.selectionStart).match(MENTION_BEFORE_CARET);
      choices = match ? (handlers.mentionChoices?.(match[2]) ?? []) : [];
      selected = 0;
      drawMenu();
      layout();
    };
    const drawMenu = () => fillMentionMenu(menu, choices, selected, (choice) => pick(choice.name));
    const pick = (name) => {
      const before = box.value.slice(0, box.selectionStart).replace(/@[A-Za-z0-9._-]*$/, `@${name} `);
      box.value = before + box.value.slice(box.selectionStart);
      box.setSelectionRange(before.length, before.length);
      choices = [];
      drawMenu();
      if (draftKey) replyDrafts.set(draftKey, box.value);
    };
    const post = async () => {
      const body = box.value.trim();
      if (!body) return;
      box.disabled = true;
      send.disabled = true;
      try {
        await submit(body);
        box.value = '';
      } finally {
        box.disabled = false;
        grow();
      }
    };

    box.addEventListener('input', update);
    box.addEventListener('blur', () => setTimeout(() => { menu.hidden = true; }, 100));
    box.addEventListener('keydown', (event) => {
      if (choices.length > 0 && !menu.hidden && ['ArrowDown', 'ArrowUp', 'Enter', 'Tab'].includes(event.key)) {
        event.preventDefault();
        if (event.key === 'ArrowDown') selected = (selected + 1) % choices.length;
        else if (event.key === 'ArrowUp') selected = (selected - 1 + choices.length) % choices.length;
        else pick(choices[selected].name);
        drawMenu();
        return;
      }
      if (event.key === 'Escape' && !menu.hidden) {
        event.preventDefault();
        choices = [];
        drawMenu();
      } else if (event.key === 'Escape') {
        event.preventDefault();
        cancel();
      } else if (event.key === 'Enter' && !event.shiftKey) {
        event.preventDefault();
        post();
      }
    });
    send.addEventListener('click', post);
    cancelButton.addEventListener('click', cancel);
    wrap.append(box, menu, buttons);
    requestAnimationFrame(() => {
      grow();
      layout();
    });
    return wrap;
  }

  // ---- layout: cards beside their text, never overlapping ----

  function layout() {
    foldBodies();
    const placed = [...margin.querySelectorAll(':scope > :is(.pj-card, .pj-unplaced)')];
    if (!beside()) {
      for (const card of placed) card.style.top = '';
      margin.style.height = '';
      return;
    }
    const aside = placed.filter((card) => card.classList.contains('pj-card-aside'));
    const byId = new Map(threads.map((t) => [t.id, t]));
    const items = placed.filter((card) => !aside.includes(card)).map((card) => {
      const id = card.dataset.thread;
      // The draft card can outlive `draft` until the next render (cancelling
      // repaints the doc, which lays out the margin first).
      return { card, id, anchor: id === 'draft' ? draft?.anchor : byId.get(id)?.anchor };
    });
    const tops = handlers.anchorTops(items.filter((i) => i.anchor));
    const origin = margin.getBoundingClientRect().top;
    // The comment icon of the threads with no place, and any card whose
    // text is not found here yet, at the top.
    for (const item of items) {
      item.height = item.card.offsetHeight;
      item.want = tops.has(item.id) ? Math.max(0, tops.get(item.id) - origin) : 0;
    }
    items.sort((a, b) => a.want - b.want);

    // The open card sits at its text: the cards below give way downward,
    // those above upward, past the top if need be, to come back when it
    // closes. With none open, the cards stack from the top.
    const pivot = items.findIndex((i) => i.id === (draft ? 'draft' : activeId));
    if (items.length > 0) items[Math.max(0, pivot)].top = items[Math.max(0, pivot)].want;
    for (let i = Math.max(0, pivot) + 1; i < items.length; i++) {
      items[i].top = Math.max(items[i].want, items[i - 1].top + items[i - 1].height + GAP);
    }
    for (let i = pivot - 1; i >= 0; i--) {
      items[i].top = Math.min(items[i].want, items[i + 1].top - items[i].height - GAP);
    }
    let bottom = 0;
    for (const item of items) {
      item.card.style.top = `${item.top}px`;
      bottom = Math.max(bottom, item.top + item.height);
    }
    // Opened, the threads with no place stack from the top, over the rest.
    let top = 0;
    for (const card of aside) {
      card.style.top = `${top}px`;
      top += card.offsetHeight + GAP;
    }
    margin.style.height = `${Math.max(bottom, top) + 40}px`;
  }

  // Offer Show more only on messages cut off by their line clamp.
  function foldBodies() {
    for (const body of margin.querySelectorAll('.pj-body-folded')) {
      body.nextElementSibling.hidden = body.scrollHeight <= body.clientHeight + 1;
    }
  }

  window.addEventListener('resize', layout);
  narrow.addEventListener('change', render); // beside the text, or a list

  // The card under the pointer lights up its text. Delegated, as cards are redrawn.
  margin.addEventListener('mouseover', (event) => handlers.onHover(event.target.closest('.pj-card')?.dataset.thread ?? null));
  margin.addEventListener('mouseleave', () => handlers.onHover(null));

  return {
    /** Show `nextThreads` (from the doc host), as `nextMe` ({ id, name }) sees them; `nextEdits`: which replies edited the doc. */
    update(nextThreads, nextMe, nextEdits = {}) {
      threads = nextThreads;
      me = nextMe;
      edits = nextEdits;
      render();
    },
    /** The reply whose edits the text shows, or null. */
    setShownEdits(id) {
      shownEdits = id;
      render();
    },
    /** The buddies' statuses changed: who works on which threads. */
    setAgents(statuses) {
      agents = statuses ?? [];
      render();
    },
    startDraft(anchor) {
      draft = { anchor };
      replyDrafts.delete('draft');
      showResolved = false;
      render();
      margin.querySelector('.pj-card-draft textarea')?.focus();
    },
    /** Make `id` the active card; `focus: false` leaves the caret where it is (e.g. in the doc). */
    setActive(id, { focus = true } = {}) {
      activeId = id;
      // The threads with no place stay open while one of them is selected.
      asideOpen = threads.some((t) => t.id === id && unplaced(t));
      render();
      if (narrow.matches) margin.querySelector(`[data-thread="${id}"]`)?.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
      if (id && focus) margin.querySelector(`[data-thread="${id}"] textarea`)?.focus({ preventScroll: true });
    },
    setShowResolved(value) {
      showResolved = value;
      render();
    },
    layout,
    rerender: render,
  };
}

// Give `card` the content of `fresh` (same thread) but keep its own text box
// element. False when either has no text box, so the caller replaces the card.
function patchCard(card, fresh) {
  const box = card.querySelector('.pj-composer');
  const freshBox = fresh.querySelector('.pj-composer');
  if (!box || !freshBox) return false;
  const keep = [...card.children].find((child) => child.contains(box));
  const kids = [...fresh.childNodes];
  const slot = kids.findIndex((child) => child.contains(freshBox));
  for (const child of [...card.childNodes]) if (child !== keep) child.remove();
  for (const child of kids.slice(0, slot)) card.insertBefore(child, keep);
  for (const child of kids.slice(slot + 1)) card.append(child);
  card.className = fresh.className;
  return true;
}

/**
 * Fills `menu` (an `.pj-mentions` list) with `choices` from mentionChoices,
 * under their group headings, `selected` highlighted; `onPick(choice)` on a
 * click. Hidden when there is nothing to offer. The comment box and the doc's
 * text share it, so @ looks the same in both.
 */
function fillMentionMenu(menu, choices, selected, onPick) {
  const items = [];
  let group = null;
  choices.forEach((choice, i) => {
    if (choice.group !== group) {
      group = choice.group;
      items.push(el('li', 'pj-mentions-group', group));
    }
    const item = el('li', `pj-mention${i === selected ? ' pj-selected' : ''}`);
    item.setAttribute('role', 'option');
    item.setAttribute('aria-selected', String(i === selected));
    const who = el('span', 'pj-mention-who');
    const name = el('span', 'pj-mention-name', choice.name);
    if (choice.kind === 'agent') name.append(el('span', 'pj-ai', 'AI'));
    who.append(name);
    if (choice.tagline) who.append(el('span', 'pj-mention-sub', choice.tagline));
    item.append(avatar(choice.name, choice.kind, true, choice.id), who);
    item.addEventListener('mousedown', (event) => {
      event.preventDefault();
      onPick(choice);
    });
    items.push(item);
  });
  menu.replaceChildren(...items);
  menu.hidden = choices.length === 0;
  menu.querySelector('.pj-selected')?.scrollIntoView({ block: 'nearest' });
}

/**
 * `text` as nodes, each @name of someone in `people` ([{ name, kind }]) a
 * chip that shows their name card on hover, and each path of a file in the
 * project (`files`, a Set of paths in it, as Copy Path writes them) a link
 * that opens it with `open(path)`.
 */
function withMentions(text, people, files, open) {
  const nodes = [];
  let at = 0;
  for (const { start, end, name } of mentionSpans(text, people.map((p) => p.name))) {
    const who = people.find((p) => p.name === name);
    if (start > at) nodes.push(...withPaths(text.slice(at, start), files, open));
    const chip = el('span', `pj-at pj-at-${who.kind}`, text.slice(start, end));
    chip.dataset.mention = who.name;
    chip.dataset.mentionKind = who.kind;
    if (who.kind === 'agent') chip.style.setProperty('--buddy', buddyColor(who.id));
    nodes.push(chip);
    at = end;
  }
  if (at < text.length) nodes.push(...withPaths(text.slice(at), files, open));
  return nodes;
}

// A word is a path when a file in `files` has it, with no `./` or `/` before
// it and no punctuation after: only what is there is a link.
function withPaths(text, files, open) {
  const nodes = [];
  let at = 0;
  for (const { 0: word, index } of files?.size ? text.matchAll(/[^\s`'"()<>[\]{}]+/g) : []) {
    const written = word.replace(/[.,;:!?]+$/, '');
    const path = written.replace(/^\.?\//, '');
    if (!files.has(path)) continue;
    if (index > at) nodes.push(document.createTextNode(text.slice(at, index)));
    const link = el('a', 'pj-file-link', written);
    link.href = '#';
    link.dataset.tip = `Open ${path}`;
    link.addEventListener('click', (event) => {
      event.preventDefault();
      open(path);
    });
    nodes.push(link);
    at = index + written.length;
  }
  if (at < text.length) nodes.push(document.createTextNode(text.slice(at)));
  return nodes;
}

/**
 * Makes `node` show the name card of `name` (`kind` 'agent' or 'human'; see
 * namecard.js), `how`: 'instant' or 'click'. The card says who it is, so the
 * browser's own tooltip goes.
 */
export function namecardFor(node, name, kind, how) {
  node.dataset.mention = name;
  node.dataset.mentionKind = kind;
  node.dataset.namecard = how;
  for (const titled of [node, ...node.querySelectorAll('[title]')]) titled.removeAttribute('title');
  return node;
}

export function avatar(name, kind, small = false, id = name) {
  const agent = kind === 'agent';
  const node = el('span', `pj-avatar${agent ? ' pj-avatar-agent' : ''}${small ? ' pj-avatar-small' : ''}`);
  // A buddy's face is drawn from its id, a person's from the name (faces.js): people round
  // in a crown or top hat, buddies a circle, square, triangle, pentagon or cloud, all drawn by hand.
  node.append(agent ? agentFace(id) : personFace(name, id));
  node.title = name;
  return node;
}

function checkIcon() {
  const ns = 'http://www.w3.org/2000/svg';
  const svg = document.createElementNS(ns, 'svg');
  svg.setAttribute('viewBox', '0 0 24 24');
  svg.setAttribute('class', 'pj-check');
  svg.setAttribute('aria-hidden', 'true');
  const path = document.createElementNS(ns, 'path');
  path.setAttribute('d', 'M9 16.2 4.8 12l-1.4 1.4L9 19 21 7l-1.4-1.4z');
  svg.append(path);
  return svg;
}

function linkButton(text, onClick) {
  const button = el('button', 'pj-link-button', text);
  button.type = 'button';
  button.addEventListener('click', onClick);
  return button;
}

function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

const truncate = (s, n) => (s.length > n ? s.slice(0, n - 1) + '…' : s);

// "Ada", "Ada and Ben", "Ada, Ben and Clippy".
const listed = (names) => (names.length > 1 ? `${names.slice(0, -1).join(', ')} and ${names.at(-1)}` : names[0]);

// A comment's author as faces and name cards know them: 'agent' for a buddy.
const kindOf = (comment) => (comment.by.kind === 'ai' ? 'agent' : 'human');

function relativeTime(iso) {
  const seconds = Math.round((Date.now() - Date.parse(iso)) / 1000);
  if (seconds < 60) return 'just now';
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes} min ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours} h ago`;
  return new Date(iso).toLocaleDateString();
}
