// The header: the theme switch (light or dark, starting from the system's),
// and closing the open menu on a click elsewhere or Escape. The menus
// themselves are <details>, so they open before this script loads.
const root = document.documentElement;
root.dataset.theme = matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
document.querySelector('.site-theme').addEventListener('click', () => {
  root.dataset.theme = root.dataset.theme === 'dark' ? 'light' : 'dark';
});

const openMenu = () => document.querySelector('.site-drop[open]');
document.addEventListener('click', (event) => {
  if (!event.target.closest('.site-drop')) openMenu()?.removeAttribute('open');
});
document.addEventListener('keydown', (event) => {
  const menu = openMenu();
  if (event.key === 'Escape' && menu) {
    menu.removeAttribute('open');
    menu.querySelector('summary').focus();
  }
});
