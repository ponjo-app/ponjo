// What Lezer's Markdown parser leaves out of CommonMark and GFM, as parser
// extensions: GFM's single-tilde strikethrough, and footnotes as GitHub
// writes them (`[^1]` and `[^1]: the note`).

const TILDE = 126;
const BRACKET = 91;
const CARET = 94;

// `~x~`: a run of exactly one tilde, as `~~x~~` is a run of two.
const single = { resolve: 'Strikethrough', mark: 'StrikethroughMark' };
export const singleTilde = {
  parseInline: [{
    name: 'StrikethroughSingle',
    parse(cx, next, pos) {
      if (next !== TILDE || cx.char(pos + 1) === TILDE || cx.char(pos - 1) === TILDE) return -1;
      return cx.addDelimiter(single, pos, pos + 1, /\S/.test(cx.slice(pos + 1, pos + 2)), /\S/.test(cx.slice(pos - 1, pos)));
    },
  }],
};

const LABEL = /^\[\^([^\]\s^]+)\]/;
const DEFINITION = /^\[\^([^\]\s^]+)\]:[ \t]?/;
const BLOCK_START = /^(#{1,6}\s|>|[-*+]\s|\d+[.)]\s|```|~~~|\||<)/;

export const footnotes = {
  defineNodes: [{ name: 'FootnoteReference' }, { name: 'FootnoteDefinition', block: true }, { name: 'FootnoteLabel' }],
  parseInline: [{
    name: 'FootnoteReference',
    before: 'Link',
    parse(cx, next, pos) {
      if (next !== BRACKET || cx.char(pos + 1) !== CARET) return -1;
      const m = LABEL.exec(cx.slice(pos, cx.end));
      return m ? cx.addElement(cx.elt('FootnoteReference', pos, pos + m[0].length)) : -1;
    },
  }],
  // A note is its line and the lines after it, up to a blank line or another block.
  parseBlock: [{
    name: 'FootnoteDefinition',
    before: 'IndentedCode',
    parse(cx, line) {
      if (line.indent >= 4) return false;
      const text = line.text.slice(line.pos);
      const m = DEFINITION.exec(text);
      if (!m) return false;
      const start = cx.lineStart + line.pos;
      const children = [cx.elt('FootnoteLabel', start, start + m[0].length), ...cx.parser.parseInline(text.slice(m[0].length), start + m[0].length)];
      let end = cx.lineStart + line.text.length;
      while (cx.nextLine()) {
        const rest = line.text.slice(line.pos);
        if (line.next === -1 || DEFINITION.test(rest) || (line.indent < 2 && BLOCK_START.test(rest))) break;
        children.push(...cx.parser.parseInline(rest, cx.lineStart + line.pos));
        end = cx.lineStart + line.text.length;
      }
      cx.addElement(cx.elt('FootnoteDefinition', start, end, children));
      return true;
    },
  }],
};
