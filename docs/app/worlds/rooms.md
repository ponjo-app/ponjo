# Game rooms

How Ponjo's games ([poker](poker.md), [werewolf](werewolf.md),
[spy](spy.md)) keep a table: an authoritative room, the usual model for
turn-based games with hidden information. Each is a store of the
[runtime](../../runtime/README.md#store); its rules are each game's.

- **A room per table**, a Cloudflare Durable Object on the relay: a
  `Table` (`relay/table.js`) in the relay deployed as `ponjo-hackathon` at
  infer.ponjo.app, beside the `ANTHROPIC_API_KEY` it runs the AI seats on.
  It holds `{ rev, state }` in its storage, runs the world's `apply` on the
  runtime's core (`preview/game-tables.js`), and gives each client only
  `read(member)`. No player's page holds the state: a refresh, a closed
  page or the opener leaving loses nothing, and no player, the opener
  included, can read another's cards or role. Its storage also keeps the
  members' tokens (hashed), what it spent this hour and a hash of the
  opener's address (for its rate); a table no page has been at for a day
  is deleted.
- **Clients** connect to the room by WebSocket: people's pages, AI seats,
  the dealer. The room tells a client when its view has changed; the
  client reads again. Each page is one seat's client (`sit`,
  `preview/game-kit.js`, which holds what the three games share): the
  opener's keeps the table's secret, whose hash names the room, and plays
  as the host; a friend joins by the link.
- **Identity.** The room gives each member a token when they sit. `by` is
  the member whose token sent the change. A page that comes back with its
  token is in its seat again; one without is a new member.
- **Closing.** The host's New table closes the table: the room closes
  every page on it and deletes it, and the host's page keeps a new secret,
  so the old link opens nothing and the new table has a new link. It is
  how the host starts over: one sent away, a link given too widely, a
  table that is full.
- **Leaving.** The room is itself a member that watches presence: a player
  whose page has been gone for `RECONNECT_MS` it commits as `leave`, and
  the rules play the fallback on their turns.
- **Time.** The clock is a member that runs in the room: the room's alarm
  wakes it at its next task's `at`, and also when a page has been gone
  `RECONNECT_MS` and every 30 s while an AI seat has a task.
- **Secrets.** The dealer runs in the room; the deck leaves it only in the
  dealer's changes.
- **AI seats** run in the room, beside the store, so no page is ever handed
  an AI seat's view: whoever's key one uses could otherwise read its cards.
  The key is Ponjo's, which never leaves the relay, or a visitor's own. A
  visitor's key is their wallet's: their page gives it to the room of a
  table they opened, which holds it in memory only, uses it only for the AI
  seats they brought, and sends it to no client. It is not kept at rest. A
  room that is evicted forgets it: the AI seats on it wait until the
  visitor's page comes back and gives it again, and their turns take the
  fallback at their deadlines meanwhile. Keeping a key at rest needs a
  master secret the owner sets, to encrypt it with; keeping it across
  tables would need accounts, which the games do not have. A visitor's key
  is Anthropic's, or one for an OpenAI-compatible API at a known
  provider's host only (`OPENAI_HOSTS`, `relay/table.js`), so the room is
  no proxy: a base URL elsewhere is refused when the key is given.
- **Spending.** Each room has its own budget and rate, on Ponjo's key and
  on each visitor's, so no room spends more than its owner set: at most
  300 model calls a clock hour on Ponjo's key and 600 on a visitor's
  (`RUNS_AN_HOUR`, `OWN_RUNS_AN_HOUR`, `relay/wrangler.toml`); past that,
  the AI seats' turns take the fallback until the next hour, and the pages
  say until when. Each call on Ponjo's key also counts against the address
  that opened the table, at most 60 a minute (`INFER`), and an address
  opens at most 60 lines to tables a minute (`SEATS`).
- **Language.** A table speaks English or Chinese: the host's page says
  which (`lang` in its hello, its visitor's pick, `preview/lang.js`), and
  the room commits it, as the host, when it differs from the table's. Its
  AI players speak it, and the games deal and greet in it. Each page draws
  in its own visitor's language, the refusals in English from the rules
  and the room included.
- **Presence** goes to the room, which passes it on as each view's `seen`
  allows, and keeps none.

- **Deploys.** A page that cannot reach the room says so and tries again,
  so pages published before the relay is deployed wait for it.

## Differs

- The room sends a page its whole view each time it changes, with the
  presence it may see, instead of telling it to read again: pages have no
  `wait`, and the worlds no `past`.
- The clock and the dealer have no controllers: the room lands their due
  tasks itself, at once or on its alarm.
- The AI seats share no queue per key: each calls the model on its own.
- A visitor cannot set their key's budget or rate; they are the relay's.
