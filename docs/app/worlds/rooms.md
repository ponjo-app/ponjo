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
- **Time.** The room's alarm is the clock: it commits each of
  `deadlines(state)` at its `at`.
- **Secrets.** The dealer runs in the room; the deck leaves it only in the
  dealer's changes.
- **AI seats** are clients whose program is an agent program. An AI seat's
  owner is whoever's key it uses: Ponjo's, and it runs in the room; or a
  visitor's own, and it runs in their page, which is then its host and
  holds its local.
- **Presence** goes to the room, which passes it on as each view's `seen`
  allows, and keeps none.

It replaces the opener's page as the store, the forwarding in
`preview/poker-share.js`, each game's own view for friends (poker's
`share`) and the pages' timers. The relay keeps state for it; today it
keeps none ([architecture](../architecture.md)).

## Today

The table is in the memory of the page that opened it: a refresh ends the
game, and the opener's page can read every card and role. Friends read and
act through that page over the relay, and a friend is whoever their page
says it is (`preview/poker.js:871`, `preview/werewolf.js:948-950`).
