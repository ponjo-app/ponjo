import { test } from 'node:test';
import assert from 'node:assert/strict';
import { editorParser, editorSerializer } from './milkdown.js';

test('editor: an image without a title survives parse and serialize', async () => {
  const parse = await editorParser();
  const serialize = await editorSerializer();
  for (const markdown of ['look ![alt text](a.png) here\n', '![](a.png)\n', 'look ![alt](a.png "A title") here\n']) {
    const doc = parse(markdown);
    let images = 0;
    doc.descendants((node) => { if (node.type.name === 'image') images += 1; });
    assert.equal(images, 1, markdown);
    assert.equal(serialize(doc), markdown);
  }
});

test('editor: text typed right after a link is not part of it', async () => {
  const parse = await editorParser();
  assert.equal(parse('[a](x)\n').type.schema.marks.link.spec.inclusive, false);
});

test('editor: a paragraph holding only a line break, as pasted text brings, saves', async () => {
  const serialize = await editorSerializer();
  const schema = (await editorParser())('x').type.schema;
  const { doc, heading, paragraph, hardbreak } = schema.nodes;
  const blank = paragraph.create(null, hardbreak.create());
  assert.equal(serialize(doc.create(null, [heading.create({ level: 1 }, schema.text('A')), blank, heading.create({ level: 2 }, schema.text('B'))])), '# A\n\n\n\n## B\n');
});
