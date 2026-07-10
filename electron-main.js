const { app: electronApp, BrowserWindow, dialog, ipcMain } = require('electron');
const path = require('path');
const { app: server } = require('./server');

let win;

function createWindow(port) {
  win = new BrowserWindow({
    width: 1440,
    height: 900,
    title: 'Local LLM IDE',
    backgroundColor: '#1e1e1e',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });
  win.loadURL(`http://127.0.0.1:${port}`);
}

ipcMain.handle('pick-folder', async () => {
  const result = await dialog.showOpenDialog(win, { properties: ['openDirectory', 'createDirectory'] });
  return result.canceled ? null : result.filePaths[0];
});

electronApp.whenReady().then(() => {
  // Port 0 = let the OS pick a free port, so we never collide with anything.
  const listener = server.listen(0, '127.0.0.1', () => {
    createWindow(listener.address().port);
  });
  electronApp.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow(listener.address().port);
  });
});

electronApp.on('window-all-closed', () => electronApp.quit());
