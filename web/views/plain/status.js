// The plain view's part of the doc's status bar (web/docbar.js): where the
// caret is and the selection's size on the left; on the right the indent
// Tab types, which opens a menu of others (they change the view's settings,
// so only what is typed later, never the file), and toggles for wrapping
// and whitespace. Only an editable view has it.

const INDENTS = [['tabs', 'Tab'], [2, '2 spaces'], [4, '4 spaces'], [8, '8 spaces']];
const indentName = ({ tabs, size }) => (tabs ? 'Tab' : `${size} spaces`);

const ACTIONS = `
<button type="button" class="pj-status-indent" aria-haspopup="listbox" aria-expanded="false"></button>
<button type="button" data-setting="wrap" aria-pressed="false" data-tip="Wrap long lines">Wrap</button>
<button type="button" data-setting="whitespace" aria-pressed="false" data-tip="Show all whitespace">Whitespace</button>
<ul class="pj-block-menu" role="listbox" aria-label="Indent with" hidden></ul>`;

/**
 * Fill the view's part of the doc's status bar `docbar` for `view` (a
 * CodeMirror EditorView). `save(patch)` saves a change to the view's
 * settings. `update()` repaints the caret's place; `paint(settings,
 * indent)` what depends on the settings; `destroy()` takes the part away.
 */
export function createStatusBar(view, docbar, save) {
  const position = docbar.querySelector('.pj-status-view');
  const bar = docbar.querySelector('.pj-status-view-actions');
  bar.innerHTML = ACTIONS;
  const indentButton = bar.querySelector('.pj-status-indent');
  const menu = bar.querySelector('.pj-block-menu');
  const toggles = [...bar.querySelectorAll('[data-setting]')];
  let own;

  menu.replaceChildren(...INDENTS.map(([value, label]) => {
    const item = document.createElement('li');
    item.setAttribute('role', 'option');
    item.tabIndex = 0;
    item.dataset.indent = value;
    item.textContent = label;
    return item;
  }));

  const close = () => {
    menu.hidden = true;
    indentButton.setAttribute('aria-expanded', 'false');
  };
  indentButton.addEventListener('click', () => {
    if (!menu.hidden) return close();
    const box = indentButton.getBoundingClientRect();
    menu.hidden = false;
    Object.assign(menu.style, { right: `${innerWidth - box.right}px`, bottom: `${innerHeight - box.top + 4}px`, margin: 0 });
    indentButton.setAttribute('aria-expanded', 'true');
    menu.querySelector('[aria-selected="true"]')?.focus();
  });
  const choose = (item) => {
    close();
    indentButton.focus();
    save(item.dataset.indent === 'tabs' ? { indent: 'tabs' } : { indent: 'spaces', tabWidth: Number(item.dataset.indent) });
  };
  menu.addEventListener('click', (event) => event.target.closest('li') && choose(event.target.closest('li')));
  menu.addEventListener('keydown', (event) => {
    if (event.key === 'Escape') {
      close();
      indentButton.focus();
    } else if (event.key === 'Enter' || event.key === ' ') {
      event.preventDefault();
      choose(event.target);
    }
  });
  const done = new AbortController();
  document.addEventListener('mousedown', (event) => {
    if (!menu.hidden && !menu.contains(event.target) && event.target !== indentButton) close();
  }, { signal: done.signal });

  bar.addEventListener('click', (event) => {
    const { setting } = event.target.closest('[data-setting]')?.dataset ?? {};
    if (setting === 'wrap') save({ wrap: !own.wrap });
    else if (setting === 'whitespace') save({ whitespace: own.whitespace === 'all' ? 'selection' : 'all' });
  }, { signal: done.signal }); // the slot is the page's: it outlives this view

  function update() {
    const { state } = view;
    const { from, to, head } = state.selection.main;
    const line = state.doc.lineAt(head);
    const selected = from === to ? '' : ` · ${[...state.sliceDoc(from, to)].length.toLocaleString()} selected`;
    position.textContent = `Ln ${line.number.toLocaleString()}, Col ${(head - line.from + 1).toLocaleString()}${selected}`;
  }

  function paint(settings, indent) {
    own = settings;
    indentButton.textContent = `Indent: ${indentName(indent)}`;
    for (const item of menu.children) item.setAttribute('aria-selected', String(item.textContent === indentName(indent)));
    for (const toggle of toggles) toggle.setAttribute('aria-pressed', String(toggle.dataset.setting === 'wrap' ? settings.wrap : settings.whitespace === 'all'));
  }

  update();
  return {
    update,
    paint,
    destroy() {
      done.abort();
      bar.replaceChildren();
      position.textContent = '';
    },
  };
}
