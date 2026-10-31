// Searching text (src/core/search.js), as the find bar and the sidebar's
// search do: plain text unless asked for a regular expression, case
// ignored unless asked, whole words, and $1 in what replaces a match.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { expand, matches, searchPattern } from '../src/core/search.js';

const find = (text, query, options) => matches(text, searchPattern(query, options)).map(([start, end]) => text.slice(start, end));

test('plain text by default: what is typed, case ignored, a regular expression\'s characters as themselves', () => {
  assert.deepEqual(find('What? what. WHAT?', 'what?'), ['What?', 'WHAT?']);
  assert.deepEqual(find('a.b axb (c)', 'a.b'), ['a.b']);
  assert.deepEqual(find('(c) [d] $e', '(c)'), ['(c)']);
  assert.equal(searchPattern(''), null, 'nothing to find');
});

test('Match case, Whole word and Regular expression, alone and together', () => {
  assert.deepEqual(find('Cat cat CAT', 'cat', { matchCase: true }), ['cat']);
  assert.deepEqual(find('cat cats concat cat_x cat.', 'cat', { wholeWord: true }), ['cat', 'cat']);
  assert.deepEqual(find('猫cat 猫 cat', 'cat', { wholeWord: true }), ['cat'], 'a letter of any script is part of a word');
  assert.deepEqual(find('v1 v22 vx', 'v\\d+', { regex: true }), ['v1', 'v22']);
  assert.deepEqual(find('foo|bar foobar', 'foo|bar', { regex: true, wholeWord: true }), ['foo', 'bar'], 'whole word holds around every alternative');
  assert.deepEqual(find('Ab ab', '[a]b', { regex: true, matchCase: true }), ['ab']);
});

test('a query that is not a regular expression finds nothing; an empty match is no match', () => {
  assert.equal(searchPattern('a(', { regex: true }), null);
  assert.deepEqual(matches('abc', searchPattern('x*', { regex: true })), []);
  assert.deepEqual(matches('abc', null), []);
});

test('expand: $& the match, $1 and $<name> its groups, $$ a dollar, the rest as written', () => {
  const [[, , match]] = matches('John Smith', searchPattern('(?<first>\\w+) (\\w+)', { regex: true }));
  assert.equal(expand('$2, $1', match), 'Smith, John');
  assert.equal(expand('$<first>!', match), 'John!');
  assert.equal(expand('[$&] costs $$5', match), '[John Smith] costs $5');
  assert.equal(expand('$0 $3 $<nope>', match), '$0 $3 ', 'no group 0 or 3; a missing name is empty, as String.replace does');
  assert.equal(expand('$10', match), 'John0', 'group 1, then 0, when there is no group 10');
});
