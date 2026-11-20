// Sets up a Hold'em table to play in the Ponjo desktop app with buddies.
// Usage: node experiments/holdem/app/setup.mjs <project folder> [--you <your seat name>]
// It makes <project folder>/table.md and its buddies Alice, Bob and Cara
// (.ponjo/buddies), and writes the agent script "holdem" (and its manifest)
// into the app's agents folder. It changes no setting: you pick the agent.
import { chmodSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { configDir } from '../../../src/store/settings.js';

const here = dirname(fileURLToPath(import.meta.url));
const [folderArg, ...rest] = process.argv.slice(2);
if (!folderArg) {
  console.error('Usage: node experiments/holdem/app/setup.mjs <project folder> [--you <name>]');
  process.exit(1);
}
const folder = resolve(folderArg);
const you = rest.includes('--you') ? rest[rest.indexOf('--you') + 1] : 'You';
const styles = { Alice: 'Cautious: you fold weak hands to a raise and rarely raise yourself.', Bob: 'Aggressive: you raise with any decent hand and like to put pressure on.', Cara: 'Thoughtful: you weigh the pot odds and the board before each move.' };

mkdirSync(join(folder, '.ponjo', 'buddies'), { recursive: true });
writeFileSync(join(folder, 'table.md'), "# Open-card Hold'em\n\nWaiting for the dealer.\n");
for (const [name, style] of Object.entries(styles)) {
  writeFileSync(join(folder, '.ponjo', 'buddies', `${name}.md`), `You play the seat ${name} at the open-card Hold'em table in this doc; every seat's cards are public. Only when the doc says \`Action on: ${name}\`, choose check, call, fold or raise from the cards, the board, the pot and the current bet; write it after \`act=\` on the line \`Seat ${name}:\` and change nothing else in the doc. Then comment one short sentence on why, in character. ${style}\n`);
}
const agents = join(configDir(), 'agents');
mkdirSync(agents, { recursive: true });
const script = readFileSync(join(here, 'holdem.sh'), 'utf8').replace('__NODE__', process.execPath).replace('__AGENT__', join(here, '..', 'agent.mjs'));
writeFileSync(join(agents, 'holdem'), script);
chmodSync(join(agents, 'holdem'), 0o755);
writeFileSync(join(agents, 'holdem.json'), readFileSync(join(here, 'holdem.json')));

const dealer = join(here, '..', 'dealer.mjs');
console.log(`Table: ${join(folder, 'table.md')}
Agent script: ${join(agents, 'holdem')}

1. npm run desktop, open the folder ${folder} and its table.md.
2. Settings > Agents: pick "Hold'em seat", and its Player: Fake (instant) or Claude Code.
3. On the cards of Alice, Bob and Cara: turn on Watch this doc.
4. Deal (3 hands; Ctrl+C to stop):
   node "${dealer}" "${join(folder, 'table.md')}" "${join(folder, '.holdem')}" 3 --seats Alice,Bob,Cara,${you}
5. When the doc says "Action on: ${you}", type check, call, fold or raise after act= on the line "Seat ${you}:".
   While a buddy thinks, don't type in the doc: a person typing stops a watch run, and it starts over.`);
