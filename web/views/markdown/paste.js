// Pasting into the Markdown view. Formatted text (HTML, from a web page, a
// doc or another editor) is turned into Markdown once, as it is pasted, so
// what shows is what is saved; images held in the page itself (`data:`,
// `blob:`), whose bytes would land in the file, are left out. Plain text goes
// in as it is, so pasted Markdown formats; Mod+Shift+V pastes any clipboard's
// plain text. A single URL pasted over selected text links the text.

import { EditorView } from '@codemirror/view';
import TurndownService from 'turndown';
import { gfm } from 'turndown-plugin-gfm';

const URL_ONLY = /^(https?:\/\/|mailto:)\S+$/i;

let turndown = null;
/** `html` as Markdown, in the style the toolbar types. */
export function htmlToMarkdown(html) {
  if (!turndown) {
    turndown = new TurndownService({ headingStyle: 'atx', hr: '---', bulletListMarker: '-', codeBlockStyle: 'fenced', emDelimiter: '*', strongDelimiter: '**' });
    turndown.use(gfm);
    turndown.addRule('pageImages', {
      filter: (node) => node.nodeName === 'IMG' && /^\s*(data|blob):/i.test(node.getAttribute('src') ?? ''),
      replacement: () => '',
    });
    // A list item's marker and one space, its other lines under its text.
    turndown.addRule('listItem', {
      filter: 'li',
      replacement(content, node, options) {
        const list = node.parentNode;
        const start = Number(list.getAttribute('start') ?? 1);
        const marker = list.nodeName === 'OL' ? `${start + Array.prototype.indexOf.call(list.children, node)}. ` : `${options.bulletListMarker} `;
        const text = content.replace(/^\n+/, '').replace(/\n+$/, '\n').replace(/\n(?=.)/g, `\n${' '.repeat(marker.length)}`);
        return marker + text + (node.nextSibling && !text.endsWith('\n') ? '\n' : '');
      },
    });
    turndown.addRule('strikethrough', {
      filter: ['del', 's', 'strike'],
      replacement: (content) => `~~${content}~~`,
    });
    // Google Docs wraps what is copied in a <b> that is not bold.
    turndown.addRule('notBold', {
      filter: (node) => node.nodeName === 'B' && /font-weight:\s*(normal|400)/.test(node.getAttribute('style') ?? ''),
      replacement: (content) => content,
    });
  }
  return turndown.turndown(html).replace(/\n{3,}/g, '\n\n');
}

export const paste = () => {
  let asText = false; // the last key pressed was Mod+Shift+V
  return EditorView.domEventHandlers({
    keydown(event) {
      asText = event.shiftKey && event.code === 'KeyV';
      return false;
    },
    paste(event, view) {
      const plain = asText;
      asText = false;
      const data = event.clipboardData;
      if (!data || view.state.readOnly) return false;
      const text = data.getData('text/plain');
      const html = data.getData('text/html');
      const { from, to, empty } = view.state.selection.main;
      let insert;
      if (!empty && URL_ONLY.test(text.trim())) insert = `[${view.state.sliceDoc(from, to)}](${text.trim()})`;
      else if (!plain && html && !data.types.includes('vscode-editor-data')) insert = htmlToMarkdown(html);
      else return false; // CodeMirror pastes the plain text as it is
      event.preventDefault();
      view.dispatch(view.state.replaceSelection(insert), { userEvent: 'input.paste', scrollIntoView: true });
      return true;
    },
  });
};
