// The browser the relay test (test/relay.test.js) opens a teammate's page
// in: one window on RELAY_PAGE. Asked to leave with typing not landed, it
// leaves, as a person who clicks Leave would; no one is there to answer.

import { app, BrowserWindow } from 'electron';

app.whenReady().then(() => {
  const win = new BrowserWindow({ width: 1000, height: 700, show: false, webPreferences: { backgroundThrottling: false } });
  win.webContents.on('will-prevent-unload', (event) => event.preventDefault());
  win.loadURL(process.env.RELAY_PAGE);
});
