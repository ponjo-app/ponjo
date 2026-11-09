// Pasting into the Markdown view. Formatted text (HTML, from a web page, a
// doc or another editor) is turned into Markdown once, as it is pasted, so
// what shows is what is saved; images held in the page itself (`data:`,
// `blob:`), whose bytes would land in the file, are left out. Plain text goes
// in as it is, so pasted Markdown formats; Mod+Shift+V pastes any clipboard's
// plain text. A single URL pasted over selected text links the text.
// An image pasted with no text (a screenshot), or dropped in, is written
// beside the doc by `saveImage`, given (the owner's page), and linked at the
// caret or where it was dropped; with no `saveImage`, it is left out.

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

// The image files of a clipboard or a drop.
const imagesOf = (data) => [...(data?.files ?? [])].filter((file) => file.type.startsWith('image/'));

const base64 = (file) => new Promise((done, fail) => {
  const reader = new FileReader();
  reader.onload = () => done(String(reader.result).split(',')[1] ?? '');
  reader.onerror = () => fail(reader.error);
  reader.readAsDataURL(file);
});

// Write `files` and link them at the caret, one after another.
async function insertImages(view, files, saveImage) {
  for (const file of files) {
    let src;
    try {
      src = await saveImage({ name: file.name, type: file.type, data: await base64(file) });
    } catch (error) {
      console.warn(`The image was not added: ${error.message}`);
      continue;
    }
    view.dispatch(view.state.replaceSelection(`![](${src})`), { userEvent: 'input.paste', scrollIntoView: true });
  }
}

export const paste = (saveImage = null) => {
  let asText = false; // the last key pressed was Mod+Shift+V
  return EditorView.domEventHandlers({
    dragover(event) {
      if (imagesOf(event.dataTransfer).length > 0 || event.dataTransfer?.types.includes('Files')) event.preventDefault(); // a drop, not the page opening the file
      return false;
    },
    drop(event, view) {
      const files = imagesOf(event.dataTransfer);
      if (files.length === 0 || view.state.readOnly) return false;
      event.preventDefault();
      const at = view.posAtCoords({ x: event.clientX, y: event.clientY });
      if (saveImage && at !== null) {
        view.dispatch({ selection: { anchor: at } });
        view.focus();
        insertImages(view, files, saveImage);
      }
      return true;
    },
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
      const images = text ? [] : imagesOf(data);
      if (images.length > 0 && (saveImage || !html)) {
        event.preventDefault();
        if (saveImage) insertImages(view, images, saveImage);
        return true;
      }
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
