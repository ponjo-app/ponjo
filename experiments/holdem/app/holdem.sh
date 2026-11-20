#!/bin/sh
# A Ponjo agent script for a Hold'em seat (docs/agent-config.md), written
# into the app's agents/ folder by setup.mjs as "holdem".
# 1. Wake line: until its next run, this buddy is woken only while the doc
#    holds "Action on: <its name>" (PONJO_WAKE).
# 2. Gate, for free: not its turn, or already acted: exit 0, nothing changed.
# 3. Its turn: the player Settings > Agents picks, the fake one or Claude Code.
[ -n "$PONJO_WAKE" ] && printf '{"line":"Action on: %s"}\n' "$PONJO_BUDDY" >> "$PONJO_WAKE"
grep -qx "Action on: $PONJO_BUDDY" "$PONJO_DOC" || exit 0
grep -q "^Seat $PONJO_BUDDY: .*act=[a-z]" "$PONJO_DOC" && exit 0
if [ "$PONJO_SETTING_PLAYER" = claude ]; then exec "$(dirname "$0")/claude"; fi
exec "__NODE__" "__AGENT__"
