// Local LLM IDE backend: serves the UI, exposes workspace file APIs, and proxies
// streaming chat (with an agent tool loop) to the local Ollama daemon.
const express = require('express');
const path = require('path');
const fs = require('fs/promises');
const fsSync = require('fs');
const os = require('os');
const { execFile, spawn } = require('child_process');

const OLLAMA = process.env.OLLAMA_HOST_URL || 'http://127.0.0.1:11434';
// DwarfStar (ds4) — local DeepSeek V4 Flash server, fully offline.
const DS4 = {
  url: process.env.DS4_URL || 'http://127.0.0.1:8000',
  bin: process.env.DS4_BIN || `${os.homedir()}/ds4/ds4-server`,
  dir: process.env.DS4_DIR || `${os.homedir()}/ds4`,
  gguf: process.env.DS4_GGUF || 'gguf/DeepSeek-V4-Flash-IQ2XXS-w2Q2K-AProjQ8-SExpQ8-OutQ8-chat-v2-imatrix.gguf',
  // >= 393216 enables Think Max per the model card; smaller falls back to high.
  ctx: process.env.DS4_CTX || '393216',
  autoStart: process.env.DS4_AUTOSTART !== '0',
};
const DS4_PREFIX = 'ds4:';
const DEFAULT_MODEL = DS4_PREFIX + 'deepseek-v4-flash';
// DeepSeek's recommended sampling — pinned so no client default drifts.
const SAMPLING = { temperature: 1.0, top_p: 1.0 };

let ds4Spawned = false;
async function ds4Alive() {
  try {
    const r = await fetch(`${DS4.url}/v1/models`, { signal: AbortSignal.timeout(1500) });
    return r.ok;
  } catch {
    return false;
  }
}

const ds4Port = () => new URL(DS4.url).port || '8000';

function spawnDs4(opts = {}) {
  const kvDir = path.join(os.homedir(), '.ds4-server-kv');
  fsSync.mkdirSync(kvDir, { recursive: true });
  const log = fsSync.openSync(path.join(os.homedir(), '.ds4-server.log'), 'a');
  const args = ['--chdir', DS4.dir, '-m', DS4.gguf, '--host', '127.0.0.1', '--port', ds4Port(),
    '--kv-disk-dir', kvDir, '--kv-disk-space-mb', '8192', '--ctx', String(opts.ctx || DS4.ctx)];
  if (opts.power) args.push('--power', String(opts.power));
  if (opts.extra) args.push(...String(opts.extra).split(/\s+/).filter(Boolean));
  const child = spawn(DS4.bin, args, { detached: true, stdio: ['ignore', log, log] });
  child.unref();
  ds4Spawned = true;
  console.log(`spawned ds4-server pid ${child.pid}: ${args.join(' ')}`);
  return child.pid;
}

// If no ds4-server is listening, launch one detached so it outlives the IDE.
async function ensureDs4() {
  if (await ds4Alive()) return 'running';
  if (!DS4.autoStart || ds4Spawned) return 'down';
  if (!fsSync.existsSync(DS4.bin)) return 'missing';
  spawnDs4();
  return 'starting';
}

// pid + args of whatever is listening on the ds4 port.
function ds4Process() {
  return new Promise((resolve) => {
    execFile('lsof', ['-ti', `tcp:${ds4Port()}`, '-sTCP:LISTEN'], (err, out) => {
      const pid = parseInt(out, 10);
      if (!pid) return resolve(null);
      execFile('ps', ['-p', String(pid), '-o', 'args='], (err2, args) => {
        resolve({ pid, args: (args || '').trim() });
      });
    });
  });
}

const app = express();
app.use(express.json({ limit: '50mb' }));
app.use('/vendor/monaco', express.static(path.join(__dirname, 'node_modules/monaco-editor/min')));
app.use('/vendor/marked', express.static(path.join(__dirname, 'node_modules/marked')));
app.use('/', express.static(path.join(__dirname, 'ui')));

// ---------- helpers ----------

const IGNORED = new Set(['.git', '.DS_Store']);

function safeResolve(root, rel) {
  if (!root) throw new Error('no workspace root provided');
  const abs = path.resolve(root, rel || '.');
  const normRoot = path.resolve(root);
  if (abs !== normRoot && !abs.startsWith(normRoot + path.sep)) {
    throw new Error(`path escapes workspace: ${rel}`);
  }
  return abs;
}

function sendErr(res, err, code = 400) {
  res.status(code).json({ error: String(err.message || err) });
}

// ---------- workspace / files ----------

app.get('/api/home', (req, res) => {
  res.json({ home: os.homedir(), cwd: process.cwd() });
});

app.get('/api/tree', async (req, res) => {
  try {
    const abs = safeResolve(req.query.root, req.query.path || '.');
    const entries = await fs.readdir(abs, { withFileTypes: true });
    const items = entries
      .filter((e) => !IGNORED.has(e.name))
      .map((e) => ({ name: e.name, type: e.isDirectory() ? 'dir' : 'file' }))
      .sort((a, b) => (a.type === b.type ? a.name.localeCompare(b.name) : a.type === 'dir' ? -1 : 1));
    res.json({ items });
  } catch (err) {
    sendErr(res, err);
  }
});

app.get('/api/file', async (req, res) => {
  try {
    const abs = safeResolve(req.query.root, req.query.path);
    const stat = await fs.stat(abs);
    if (stat.size > 2 * 1024 * 1024) throw new Error('file too large to open (>2MB)');
    const content = await fs.readFile(abs, 'utf8');
    res.json({ content });
  } catch (err) {
    sendErr(res, err);
  }
});

app.put('/api/file', async (req, res) => {
  try {
    const { root, path: rel, content } = req.body;
    const abs = safeResolve(root, rel);
    await fs.mkdir(path.dirname(abs), { recursive: true });
    await fs.writeFile(abs, content, 'utf8');
    res.json({ ok: true });
  } catch (err) {
    sendErr(res, err);
  }
});

app.get('/api/models', async (req, res) => {
  const models = [];
  const ds4Status = await ensureDs4();
  if (ds4Status === 'running' || ds4Status === 'starting') models.push(DS4_PREFIX + 'deepseek-v4-flash');
  try {
    const r = await fetch(`${OLLAMA}/api/tags`, { signal: AbortSignal.timeout(1500) });
    const data = await r.json();
    for (const m of data.models || []) models.push(m.name);
  } catch { /* Ollama not running — ds4 alone is fine */ }
  res.json({ models, ds4: ds4Status });
});

app.get('/api/ds4/status', async (req, res) => {
  const [proc, alive] = await Promise.all([ds4Process(), ds4Alive()]);
  const ctxMatch = proc?.args.match(/--ctx\s+(\d+)/);
  const ctx = ctxMatch ? parseInt(ctxMatch[1], 10) : null;
  res.json({
    alive,
    loading: !!proc && !alive,
    pid: proc?.pid || null,
    args: proc?.args || null,
    ctx,
    thinkMaxCapable: ctx !== null && ctx >= 393216,
  });
});

// Restart ds4-server with a new launch configuration: kills the ds4-server
// that owns the port, then spawns a fresh detached one with the new flags.
app.post('/api/ds4/restart', async (req, res) => {
  try {
    const { ctx, power, extra } = req.body || {};
    if (!fsSync.existsSync(DS4.bin)) throw new Error(`ds4-server binary not found at ${DS4.bin}`);
    const proc = await ds4Process();
    if (proc && !/ds4-server/.test(proc.args)) {
      throw new Error(`port ${ds4Port()} is held by a non-ds4 process (pid ${proc.pid}); not touching it`);
    }
    if (proc) {
      process.kill(proc.pid, 'SIGTERM');
      for (let i = 0; i < 30 && (await ds4Process()); i++) {
        await new Promise((r) => setTimeout(r, 500));
      }
      if (await ds4Process()) throw new Error('old ds4-server did not release the port');
    }
    const pid = spawnDs4({ ctx, power, extra });
    res.json({ ok: true, pid });
  } catch (err) {
    sendErr(res, err, 500);
  }
});

app.get('/api/system', (req, res) => {
  const total = os.totalmem();
  const cpu = Math.min(100, Math.round((os.loadavg()[0] / os.cpus().length) * 100));
  // vm_stat gives real pressure; os.freemem() would count file cache as used.
  execFile('vm_stat', (err, out) => {
    let used = total - os.freemem();
    if (!err) {
      const page = parseInt(out.match(/page size of (\d+)/)?.[1] || '16384', 10);
      const grab = (label) => parseInt(out.match(new RegExp(`${label}:\\s+(\\d+)`))?.[1] || '0', 10);
      used = (grab('Pages active') + grab('Pages wired down') + grab('Pages occupied by compressor')) * page;
    }
    res.json({
      cpu,
      ram: Math.round((used / total) * 100),
      ramUsedGB: +(used / 1e9).toFixed(1),
      ramTotalGB: Math.round(total / 1e9),
    });
  });
});

// ---------- agent tools ----------

const TOOL_DEFS = [
  {
    type: 'function',
    function: {
      name: 'read_file',
      description: 'Read a text file from the workspace. Path is relative to the workspace root.',
      parameters: {
        type: 'object',
        properties: { path: { type: 'string', description: 'Relative path of the file to read' } },
        required: ['path'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'write_file',
      description: 'Create or overwrite a text file in the workspace. Path is relative to the workspace root.',
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string', description: 'Relative path of the file to write' },
          content: { type: 'string', description: 'Full new content of the file' },
        },
        required: ['path', 'content'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'list_directory',
      description: 'List files and subdirectories at a path relative to the workspace root.',
      parameters: {
        type: 'object',
        properties: { path: { type: 'string', description: 'Relative directory path, "." for the root' } },
        required: ['path'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'run_command',
      description:
        'Run a shell command with the workspace root as the working directory. Returns stdout and stderr. 120s timeout.',
      parameters: {
        type: 'object',
        properties: { command: { type: 'string', description: 'The shell command to run' } },
        required: ['command'],
      },
    },
  },
];

async function runTool(name, args, workspace) {
  switch (name) {
    case 'read_file': {
      const abs = safeResolve(workspace, args.path);
      return await fs.readFile(abs, 'utf8');
    }
    case 'write_file': {
      const abs = safeResolve(workspace, args.path);
      await fs.mkdir(path.dirname(abs), { recursive: true });
      await fs.writeFile(abs, args.content, 'utf8');
      return `wrote ${args.content.length} chars to ${args.path}`;
    }
    case 'list_directory': {
      const abs = safeResolve(workspace, args.path || '.');
      const entries = await fs.readdir(abs, { withFileTypes: true });
      return entries
        .filter((e) => !IGNORED.has(e.name))
        .map((e) => (e.isDirectory() ? e.name + '/' : e.name))
        .join('\n');
    }
    case 'run_command': {
      return await new Promise((resolve) => {
        execFile(
          '/bin/zsh',
          ['-lc', args.command],
          { cwd: workspace, timeout: 120_000, maxBuffer: 4 * 1024 * 1024 },
          (err, stdout, stderr) => {
            let out = '';
            if (stdout) out += stdout;
            if (stderr) out += (out ? '\n--- stderr ---\n' : '') + stderr;
            if (err && err.killed) out += '\n[command timed out after 120s]';
            else if (err && err.code) out += `\n[exit code ${err.code}]`;
            resolve(out || '[no output]');
          }
        );
      });
    }
    default:
      throw new Error(`unknown tool: ${name}`);
  }
}

// ---------- chat (streaming NDJSON to the client) ----------

// One Ollama /api/chat round. Streams tokens to `emit`, returns the final
// assistant message (content + thinking + any tool calls).
async function ollamaRound(payload, emit, signal) {
  const attempt = async (body) =>
    fetch(`${OLLAMA}/api/chat`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal,
    });

  let r = await attempt(payload);
  if (!r.ok) {
    let errText = await r.text();
    // Some model/server combos want boolean think, or none at all — degrade gracefully.
    if (payload.think !== undefined && /think/i.test(errText)) {
      const fallback = { ...payload, think: !!payload.think };
      r = await attempt(fallback);
      if (!r.ok) {
        delete fallback.think;
        r = await attempt(fallback);
      }
      if (!r.ok) errText = await r.text();
    }
    if (!r.ok) throw new Error(`Ollama error ${r.status}: ${errText.slice(0, 400)}`);
  }

  const msg = { role: 'assistant', content: '', thinking: '', tool_calls: [] };
  let buf = '';
  for await (const chunk of r.body) {
    buf += Buffer.from(chunk).toString('utf8');
    let nl;
    while ((nl = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, nl).trim();
      buf = buf.slice(nl + 1);
      if (!line) continue;
      const data = JSON.parse(line);
      if (data.error) throw new Error(data.error);
      const m = data.message || {};
      if (m.thinking) {
        msg.thinking += m.thinking;
        emit({ type: 'thinking', content: m.thinking });
      }
      if (m.content) {
        msg.content += m.content;
        emit({ type: 'token', content: m.content });
      }
      if (m.tool_calls) msg.tool_calls.push(...m.tool_calls);
      if (data.done) {
        emit({
          type: 'stats',
          eval_count: data.eval_count,
          eval_duration: data.eval_duration,
          prompt_eval_count: data.prompt_eval_count,
        });
      }
    }
  }
  return msg;
}

// One ds4-server (OpenAI-compatible) round over SSE. Streams tokens/thinking
// to `emit`, returns the final assistant message with OpenAI-format tool calls.
async function ds4Round(payload, emit, signal) {
  const body = {
    model: 'deepseek-v4-flash',
    messages: payload.messages,
    stream: true,
    stream_options: { include_usage: true },
    ...SAMPLING, // ignored by the server in thinking mode, applied in non-think
  };
  // Server default is high-effort thinking; map the UI's three modes.
  if (payload.think === false || payload.think === undefined) body.think = false;
  else if (payload.think === 'max') body.reasoning_effort = 'max';
  if (payload.tools) body.tools = payload.tools;

  const r = await fetch(`${DS4.url}/v1/chat/completions`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
    signal,
  });
  if (!r.ok) throw new Error(`ds4-server error ${r.status}: ${(await r.text()).slice(0, 400)}`);

  const msg = { role: 'assistant', content: '', thinking: '', tool_calls: [] };
  const started = Date.now();
  let buf = '';
  for await (const chunk of r.body) {
    buf += Buffer.from(chunk).toString('utf8');
    let nl;
    while ((nl = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, nl).trim();
      buf = buf.slice(nl + 1);
      if (!line.startsWith('data:')) continue;
      const data = line.slice(5).trim();
      if (data === '[DONE]') continue;
      const ev = JSON.parse(data);
      if (ev.error) throw new Error(ev.error.message || JSON.stringify(ev.error));
      const delta = ev.choices?.[0]?.delta || {};
      if (delta.reasoning_content) {
        msg.thinking += delta.reasoning_content;
        emit({ type: 'thinking', content: delta.reasoning_content });
      }
      if (delta.content) {
        msg.content += delta.content;
        emit({ type: 'token', content: delta.content });
      }
      for (const tc of delta.tool_calls || []) {
        const slot = (msg.tool_calls[tc.index] ||= { id: tc.id, type: 'function', function: { name: '', arguments: '' } });
        if (tc.id) slot.id = tc.id;
        if (tc.function?.name) slot.function.name = tc.function.name;
        if (tc.function?.arguments) slot.function.arguments += tc.function.arguments;
      }
      if (ev.usage) {
        emit({
          type: 'stats',
          eval_count: ev.usage.completion_tokens,
          eval_duration: (Date.now() - started) * 1e6, // approx; includes prefill
          prompt_eval_count: ev.usage.prompt_tokens,
        });
      }
    }
  }
  msg.tool_calls = msg.tool_calls.filter(Boolean);
  return msg;
}

app.post('/api/chat', async (req, res) => {
  const { messages, model = DEFAULT_MODEL, think = false, agent = false, workspace } = req.body;
  res.setHeader('Content-Type', 'application/x-ndjson');
  res.setHeader('Cache-Control', 'no-cache');
  const emit = (obj) => res.write(JSON.stringify(obj) + '\n');

  const abort = new AbortController();
  // res 'close' fires on client disconnect; req 'close' would fire as soon as
  // the request body is consumed (Node 16+), aborting every call instantly.
  res.on('close', () => {
    if (!res.writableEnded) abort.abort();
  });

  try {
    const isDs4 = model.startsWith(DS4_PREFIX);
    const convo = [...messages];
    const tools = agent && workspace ? TOOL_DEFS : undefined;

    for (let round = 0; round < 25; round++) {
      const msg = isDs4
        ? await ds4Round({ messages: convo, think, tools }, emit, abort.signal)
        : await ollamaRound(
            { model, stream: true, options: { ...SAMPLING }, think, tools, messages: convo },
            emit, abort.signal
          );
      if (!msg.tool_calls.length) break;

      if (isDs4) {
        // OpenAI-format history; keep the server-issued ids so ds4's exact
        // DSML replay can reuse its KV cache.
        convo.push({ role: 'assistant', content: msg.content || null, tool_calls: msg.tool_calls });
      } else {
        convo.push({ role: 'assistant', content: msg.content, thinking: msg.thinking || undefined, tool_calls: msg.tool_calls });
      }
      for (const tc of msg.tool_calls) {
        const name = tc.function?.name;
        let args = tc.function?.arguments;
        if (typeof args === 'string') {
          try { args = JSON.parse(args); } catch { args = {}; }
        }
        emit({ type: 'tool_call', name, args });
        let result;
        try {
          result = await runTool(name, args || {}, workspace);
        } catch (err) {
          result = `ERROR: ${err.message}`;
        }
        const preview = result.length > 1500 ? result.slice(0, 1500) + `\n… [${result.length} chars total]` : result;
        emit({ type: 'tool_result', name, result: preview });
        if (isDs4) convo.push({ role: 'tool', tool_call_id: tc.id, content: String(result) });
        else convo.push({ role: 'tool', tool_name: name, name, content: String(result) });
      }
    }
    emit({ type: 'done' });
  } catch (err) {
    if (!abort.signal.aborted) emit({ type: 'error', error: String(err.message || err) });
  } finally {
    res.end();
  }
});

const PORT = process.env.PORT || 4517;
if (require.main === module) {
  app.listen(PORT, '127.0.0.1', () => {
    console.log(`Local LLM IDE running at http://127.0.0.1:${PORT}`);
  });
}
module.exports = { app, PORT };
