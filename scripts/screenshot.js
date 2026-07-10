// One-off: drive the IDE against the live local model and capture README PNGs.
// Usage: ./node_modules/.bin/electron scripts/screenshot.js <workspace> <outdir>
const { app: electronApp, BrowserWindow } = require('electron');
const path = require('path');
const fs = require('fs');
const { app: server } = require('../server');

const [workspace, outDir] = process.argv.slice(2);

async function poll(win, expr, timeoutMs, intervalMs = 500) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await win.webContents.executeJavaScript(expr)) return true;
    await new Promise((r) => setTimeout(r, intervalMs));
  }
  throw new Error(`timed out waiting for: ${expr}`);
}

async function capture(win, file) {
  const img = await win.webContents.capturePage();
  fs.writeFileSync(path.join(outDir, file), img.toPNG());
  console.log('captured', file);
}

async function run() {
  const listener = server.listen(0, '127.0.0.1');
  await new Promise((r) => listener.on('listening', r));
  const url = `http://127.0.0.1:${listener.address().port}`;

  const win = new BrowserWindow({ width: 1440, height: 900, show: true });
  await win.loadURL(url);
  await win.webContents.executeJavaScript(
    `localStorage.setItem('fc.workspace', ${JSON.stringify(workspace)});
     localStorage.setItem('fc.model', 'ds4:deepseek-v4-flash');
     localStorage.setItem('fc.think', 'high'); true`
  );
  await win.loadURL(url);
  await poll(win, `!!document.querySelector('[data-path="src"]')`, 15000);

  // Open src/tasks.py in the editor
  await win.webContents.executeJavaScript(`document.querySelector('[data-path="src"]').click(); true`);
  await poll(win, `!!document.querySelector('[data-path="src/tasks.py"]')`, 10000);
  await win.webContents.executeJavaScript(`document.querySelector('[data-path="src/tasks.py"]').click(); true`);
  await poll(win, `document.querySelectorAll('.tab').length > 0 && !!document.querySelector('#editor .view-lines')`, 15000);

  // Shot 1: chat with thinking about the open file
  await win.webContents.executeJavaScript(
    `document.querySelector('#think-select').value = 'high';
     document.querySelector('#chat-input').value = 'Add a complete() method to TaskList that marks a task done by title. Show just the method.';
     document.querySelector('#attach-file').click();
     document.querySelector('#send-btn').click(); true`
  );
  await poll(win, `document.querySelector('#stop-btn').classList.contains('hidden') && [...document.querySelectorAll('.msg.assistant')].some(m => m.textContent.length > 50)`, 300000, 1000);
  await new Promise((r) => setTimeout(r, 800));
  await capture(win, 'editor-chat.png');

  // Shot 2: agent mode running tools
  await win.webContents.executeJavaScript(
    `document.querySelector('#clear-chat').click();
     document.querySelector('#agent-toggle').checked = true;
     document.querySelector('#think-select').value = '';
     document.querySelector('#chat-input').value = 'Write tests/test_tasks.py using unittest covering TaskList.add and pending, then run it with python3 and report the result.';
     document.querySelector('#send-btn').click(); true`
  );
  await poll(win, `document.querySelector('#stop-btn').classList.contains('hidden') && document.querySelectorAll('.tool-card').length >= 2`, 480000, 1000);
  await new Promise((r) => setTimeout(r, 800));
  await capture(win, 'agent-mode.png');

  // Shot 3: DS4 launch configuration modal
  await win.webContents.executeJavaScript(`document.querySelector('#ds4-config').click(); true`);
  await poll(win, `!document.querySelector('#ds4-modal').classList.contains('hidden') && /ONLINE|OFFLINE|LOADING/.test(document.querySelector('#ds4-status-line').textContent)`, 15000);
  await new Promise((r) => setTimeout(r, 500));
  await capture(win, 'ds4-config.png');

  electronApp.quit();
}

electronApp.whenReady().then(() =>
  run().catch((err) => {
    console.error(err);
    electronApp.exit(1);
  })
);
