// A ```mermaid code block drawn as its diagram, in the Markdown view's
// preview (web/views/markdown/preview.js). Mermaid loads with the first
// diagram, and every diagram shown is drawn again when the theme changes.

let mermaid = null;
let renders = 0;
const shown = new Map(); // each diagram's element, and its redraw

function dark() {
  const { theme } = document.documentElement.dataset;
  return theme ? theme === 'dark' : matchMedia('(prefers-color-scheme: dark)').matches;
}

async function render(source) {
  mermaid ??= import('mermaid').then((module) => module.default);
  const m = await mermaid;
  m.initialize({ startOnLoad: false, theme: dark() ? 'dark' : 'default', suppressErrorRendering: true });
  return (await m.render(`pj-diagram-${++renders}`, source)).svg;
}

const redrawAll = () => { for (const draw of shown.values()) draw(); };
matchMedia('(prefers-color-scheme: dark)').addEventListener('change', redrawAll);
new MutationObserver(redrawAll).observe(document.documentElement, { attributeFilter: ['data-theme'] });

/** The diagram `source` draws, in a new element; one that does not draw shows its source and why. */
export function diagramDom(source) {
  const dom = document.createElement('div');
  dom.className = 'pj-diagram';
  const draw = async () => {
    try {
      dom.innerHTML = await render(source);
    } catch (error) {
      const code = document.createElement('pre');
      code.textContent = source;
      const message = document.createElement('p');
      message.className = 'pj-diagram-error';
      message.textContent = error.message;
      dom.replaceChildren(code, message);
    }
  };
  shown.set(dom, draw);
  draw();
  return dom;
}

/** A diagram's element is gone: it is not drawn again. */
export const forgetDiagram = (dom) => shown.delete(dom);
