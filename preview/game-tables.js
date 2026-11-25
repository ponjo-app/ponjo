// What a game table's room on the relay (relay/table.js; docs/app/worlds/rooms.md)
// runs for each of the three games: its world and first state; its people's
// host, its system members (the clock, a dealer) and its AI players, with
// each one's pace; and `body`, what a person sent made a change's body, the
// room's own randomness put in (a deal), the rest of what they sent dropped.
// The pages never load it: an AI player's program and the deal run only in
// the room, so no page holds an AI player's view or the deck.

import * as spy from './spy-world.js';
import * as werewolf from './werewolf-world.js';
import * as poker from './poker-world.js';
import { SIZES as SPY_SIZES, deal as dealWords } from './spy-rules.js';
import { deal as dealRoles } from './werewolf-rules.js';
import { draw } from './poker-dealer.js';

// How long a person whose page went has to come back (a reload) before the room takes them as gone.
export const RECONNECT_MS = 15_000;

const between = ([from, to]) => from + Math.random() * (to - from);
const text = (b, key) => (typeof b[key] === 'string' ? { [key]: b[key] } : {});
const number = (b, key) => (Number.isFinite(b[key]) ? { [key]: b[key] } : {});

// A spy or werewolf body: its type, and its text, target or name.
const said = (b) => ({ type: String(b.type), ...text(b, 'text'), ...text(b, 'name'), ...(Number.isInteger(b.target) ? { target: b.target } : {}) });

// Each AI player's pace, as a person's at a table: ms from and to before they act.
const SPY_PACE = { Ivy: [3000, 5500], Max: [1200, 2500], Juno: [2500, 4500], Sam: [2000, 3500], Lou: [2500, 5000], Remy: [3500, 6500], Pip: [1200, 2600] };

// `think`, ms from and to before they act; `type`, ms a character as they type a speech.
const WEREWOLF_PACE = {
  Rosa: { think: [3500, 6500], type: 75 },
  Jax: { think: [1500, 3000], type: 45 },
  Wen: { think: [4500, 8000], type: 90 },
  Otis: { think: [3000, 6000], type: 60 },
  Priya: { think: [2500, 4500], type: 55 },
  Bo: { think: [3000, 5500], type: 85 },
  Nell: { think: [4000, 7500], type: 80 },
};
const NIGHT_THINK = 5000; // ms a night action is thought over at most, so it fits in its call

// A model answers in a second or two, faster than a person can follow: a
// player takes at least its own time to think (more facing a bet, less to answer in the chat).
const POKER_PACE = { Gary: [1200, 2600], Duke: [700, 1600], Penny: [1800, 3600], Mabel: [1600, 3200], Lex: [800, 1800], Hank: [1000, 2200] };

export const GAMES = {
  spy: {
    world: spy.world, first: spy.newTable, host: spy.HUMAN, system: [spy.CLOCK],
    ais: spy.PERSONAS.map(({ id }) => id),
    seat: () => ({ tool: spy.DECIDE, prompt: spy.prompt, decide: (args, view) => spy.decided(args, view.actions) }),
    pace: (id) => between(SPY_PACE[id]),
    // A new game, dealt here in the table's language: the AI players fill the seats the people leave, each with its hello.
    body(b, t) {
      if (b.type !== 'start') return said(b);
      if (!SPY_SIZES.includes(b.size)) return { refused: `A game has ${SPY_SIZES.join(', ')} seats.` };
      const ais = spy.PERSONAS.slice(0, Math.max(0, b.size - t.people.length)).map(({ id, hello, zh }) => ({ id, hello: t.lang === 'zh' ? zh.hello : hello }));
      return { type: 'start', size: b.size, dealt: dealWords(b.size, t.lang), ais };
    },
  },
  werewolf: {
    world: werewolf.world, first: werewolf.newTable, host: werewolf.HUMAN, system: [werewolf.CLOCK],
    ais: werewolf.PERSONAS.map(({ id }) => id),
    seat: (id) => ({
      tool: werewolf.DECIDE, prompt: werewolf.prompt, decide: (args, view) => werewolf.decided(args, view.actions),
      // For a speech or a line, its time to type it, told as presence.
      typing: (body) => (['speak', 'chat'].includes(body.type) && body.text?.trim() ? Math.min(15_000, Math.max(1500, body.text.length * WEREWOLF_PACE[id].type)) : 0),
    }),
    // A night action less, to fit in its call.
    pace: (id, tasks, view) => between(WEREWOLF_PACE[id].think.map((ms) => (view.content.game?.phase === 'night' ? Math.min(ms, NIGHT_THINK) : ms))),
    body(b) {
      if (b.type !== 'start') return said(b);
      try {
        return { type: 'start', size: b.size, roles: dealRoles(b.size) };
      } catch (error) {
        return { refused: error.message };
      }
    },
  },
  poker: {
    world: poker.world, first: () => poker.newTable(), host: poker.HUMAN, system: [poker.CLOCK, poker.DEALER], dealer: poker.DEALER,
    ais: poker.PERSONAS.map(({ id }) => id),
    seat: () => ({ tool: poker.DECIDE, prompt: poker.prompt, decide: poker.decided }),
    pace(id, tasks, view) {
      const ms = between(POKER_PACE[id]);
      if (!tasks.some((t) => t.given.startsWith('turn:'))) return ms / 2;
      return ms + (view.content.legal?.toCall ? 600 : 0);
    },
    // The dealer's change: the cards it is to deal, from the rest of a shuffled deck: the table holds no deck.
    deal: (view) => ({ cards: draw(view.content.out, view.content.need) }),
    body(b) {
      if (b.type) return { type: String(b.type), ...number(b, 'seat'), ...text(b, 'name'), ...number(b, 'buyIn'), ...number(b, 'amount'), ...text(b, 'id') };
      const a = b.action && typeof b.action === 'object' ? { type: String(b.action.type), ...(Number.isInteger(b.action.amount) ? { amount: b.action.amount } : {}) } : null;
      return { ...(a ? { action: a } : {}), ...text(b, 'say'), ...text(b, 'react') };
    },
  },
};
