// The doc's status bar (web/docbar.js): its word count, in any script.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { wordCount } from '../web/docbar.js';

test('the word count counts words, not marks or spaces, in any script', () => {
  assert.equal(wordCount(''), 0);
  assert.equal(wordCount('# Title\n\nWe **ship** all six features, then gather feedback.\n'), 9);
  assert.equal(wordCount('- one\n- two\n\n---\n'), 2, 'list marks and rules are no words');
  assert.ok(wordCount('我们下周发布测试版') >= 3, 'Chinese, without spaces, in words');
});
