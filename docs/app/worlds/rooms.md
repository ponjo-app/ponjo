# Game rooms

How Ponjo's games ([poker](poker.md), [werewolf](werewolf.md),
[spy](spy.md)) keep a table: an authoritative room, the usual model for
turn-based games with hidden information. Each is a store of the
[runtime](../../runtime/README.md#store); its rules are each game's.

- **A room per table**, a Cloudflare Durable Object on the relay. It holds
  `{ rev, state }` in its storage, runs the world's `apply`, and gives each
  client only `read(member)`. No player's page holds the state: a refresh,
  a closed page or the opener leaving loses nothing, and no player, the
  opener included, can read another's cards or role.
- **Clients** connect to the room by WebSocket: people's pages, AI seats,
  the dealer. The room tells a client when its view has changed; the
  client reads again.
- **Identity.** The room gives each member a token when they sit. `by` is
  the member whose token sent the change. A page that comes back with its
  token is in its seat again; one without is a new member.
- **Leaving.** The room is itself a member that watches presence: a player
  whose page has been gone for `RECONNECT_MS` it commits as `leave`, and
  the rules play the fallback on their turns.
- **Time.** The clock is a member that runs in the room: the room's alarm
  wakes it at its next task's `at`.
- **Secrets.** The dealer runs in the room; the deck leaves it only in the
  dealer's changes.
- **AI seats** run in the room, beside the store, so no page is ever handed
  an AI seat's view: whoever's key one uses could otherwise read its cards.
  The key is Ponjo's, or a visitor's own. A visitor's key is kept, as their
  wallet, in the room's storage apart from the state: encrypted with a key
  held in the Worker's secrets, bound to the token of whoever gave it, used
  only for the AI seats they brought, sent to no client, and deleted when
  the table ends, they leave it or they take it back. Keeping it across
  tables would need accounts, which the games do not have.
- **Spending.** Each room has its own budget and rate, on Ponjo's key and
  on each visitor's, so no room spends more than its owner set.
- **Presence** goes to the room, which passes it on as each view's `seen`
  allows, and keeps none.

It replaces the opener's page as the store and the forwarding in
`preview/poker-share.js`. The relay keeps state for it; today it
keeps none ([architecture](../architecture.md)).

## Today

The table's store is in the page that opened it, kept in that page's
storage, so a refresh goes on with the game; that page can read every
card, role and word. Friends read and act through that page over the
relay, each sent only their seat's view, and a friend is whoever their
page says it is (`friends`, `preview/game-kit.js`).
