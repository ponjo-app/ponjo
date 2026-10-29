// The header: the Development and Preview menus, and the theme switch
// (light or dark, starting from the system's).
const root = document.documentElement;
root.dataset.theme = matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
document.querySelector('.site-theme').addEventListener('click', () => {
  root.dataset.theme = root.dataset.theme === 'dark' ? 'light' : 'dark';
});

const menus = [...document.querySelectorAll('.site-drop > button')];
const open = (button, on) => {
  button.setAttribute('aria-expanded', String(on));
  document.getElementById(button.getAttribute('aria-controls')).hidden = !on;
};
for (const button of menus) {
  button.addEventListener('click', () => {
    const on = button.getAttribute('aria-expanded') !== 'true';
    for (const other of menus) open(other, other === button && on);
  });
}
document.addEventListener('click', (event) => {
  if (!event.target.closest('.site-drop')) for (const button of menus) open(button, false);
});
document.addEventListener('keydown', (event) => {
  const button = menus.find((b) => b.getAttribute('aria-expanded') === 'true');
  if (event.key === 'Escape' && button) {
    open(button, false);
    button.focus();
  }
});
