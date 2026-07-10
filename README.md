# ⚡ Local LLM IDE

A minimal VS Code-style IDE for chatting with **DeepSeek V4 Flash** — Monaco editor, file explorer, streaming chat, and an agent mode that can read/write files and run commands in your workspace.

**Fully offline.** The default model `ds4:deepseek-v4-flash` is served by your DwarfStar `ds4-server` (`~/ds4`), running the same local GGUF your terminal `ds4-agent` uses — same weights, same runtime, no internet. If no `ds4-server` is listening on port 8000, Local LLM IDE starts one automatically (detached, so it keeps serving after Local LLM IDE quits; log at `~/.ds4-server.log`). Both processes mmap the same GGUF, so weights are shared in RAM, not loaded twice.

Ollama models (e.g. `qwen3.6:27b`) also appear in the model dropdown when the Ollama daemon is running, but nothing requires it.

## Run

```bash
npm start      # desktop app (Electron)
npm run web    # or: browser mode at http://127.0.0.1:4517
```

## Features

- **Editor** — Monaco (VS Code's editor), tabs, ⌘S to save, syntax highlighting by file type
- **Explorer** — Open Folder picks a workspace; the tree lazy-loads
- **Chat** — streams from Ollama; markdown rendering; every code block has *Copy / Insert at cursor / Replace file* buttons
- **Context** — "+ Active file" / "+ Selection" attach editor content to your next message
- **Thinking modes** — Non-think / Think High / Think Max toggle (reasoning shown in a collapsible box)
- **Agent mode** — checkbox in the top bar gives the model four tools scoped to the workspace: `read_file`, `write_file`, `list_directory`, `run_command`. Tool calls and results render as cards in the chat.
- **Stats** — tokens/sec in the status bar after each reply

## Notes

- Sampling is pinned to DeepSeek's recommended `temperature=1.0, top_p=1.0` (in `server.js`); in thinking mode ds4-server uses its fixed sampling defaults regardless, matching DeepSeek's API behavior.
- **Think Max** needs `ds4-server --ctx ≥ 393216`. Local LLM IDE auto-starts the server with `--ctx 393216`, but if you started ds4-server yourself with a smaller context (e.g. `--ctx 100000`), Think Max silently falls back to normal thinking — restart your server with a bigger `--ctx` to get it.
- Env overrides: `DS4_URL`, `DS4_BIN`, `DS4_DIR`, `DS4_GGUF`, `DS4_CTX`, `DS4_AUTOSTART=0`, `OLLAMA_HOST_URL`.
- `deepseek-v4-flash:cloud` in the dropdown is Ollama's cloud model — unrelated to your local setup and currently blocked by a lapsed subscription. You can ignore it or `ollama rm` it.
- Agent mode's `run_command` executes real shell commands in your workspace with no confirmation step. Only enable it in folders you trust it to modify.
- The server binds to `127.0.0.1` only; nothing is exposed to the network.
