# Codex WebUI

## Attribution

This project is based on [Codex-webui by HarryNeoPotter](https://github.com/harryneopotter/Codex-webui). The original code is copyright © 2025 HarryNeoPotter and is distributed under the [MIT license](LICENSE). This repository preserves the original license and Git history, with local workspace, terminal, and Codex compatibility improvements maintained by [denpth](https://github.com/denpth).

> **Website:** [https://codex-webui.hnpart.xyz/](https://codex-webui.hnpart.xyz/)

> **Looking for the TypeScript version?**  
> See [`Codex-webui-ts`](https://github.com/harryneopotter/Codex-webui/tree/Codex-webui-ts) for the modern, modular TypeScript implementation.

A responsive Web UI that wraps your local **OpenAI Codex CLI**. It streams output via **SSE** like a smooth conversation, auto-resumes from your latest `rollout-*.jsonl` file, and lets you wrangle sessions and memory—all without the terminal turning into a chaotic scribble fest.

> Not affiliated with OpenAI. Runs entirely on your machine—no clouds, no drama.

> 📖 **Want to know how this came to be?** Read the [Origin Story](ORIGIN_STORY.md) — a tale of terminal terror, internet disconnections, and a 7-hour coding marathon fueled by caffeine and desperation.

## Why This Exists
We've all been there: Codex CLI is brilliant, but terminals? Not so much. Overwriting lines, mangled scrollback, and outputs that look like abstract art gone wrong. This UI swaps the mess for a clean browser experience with real-time streaming, easy resumes, and handy tools to keep your coding sessions flowing. Because life's too short for squinting at corrupted text.

## Screenshots

### Dark Theme
![Codex WebUI - Dark Theme](assets/webui-dark.jpg)

### Light Theme
![Codex WebUI - Light Theme](assets/webui-light.jpg)

## Features
- 🔌 **Local only**: Spawns your `codex` binary right on your machine—no remote shenanigans.
- 📡 **SSE streaming** with live connection status, so you see every delta as it happens.
- ♻️ **Auto-resume** from the latest rollout or pick any session file like a pro.
- 🧠 **Memory management**: View, edit, or delete facts stored in `.codex/memory.md`.
- ⚙️ **Config tweaks**: UI for switching models, approval modes, sandboxes, and extras.
- 🛡️ **Optional security**: Bearer token for those mutating routes if you're feeling exposed.
- 🎨 **Themes**: Light and dark modes because eye strain is the real villain.

## Installation

### Prerequisites
- Node.js 18+ (because we're not living in the stone age).
- OpenAI Codex CLI installed and ready to roll.
- tmux 3.2+ installed (`brew install tmux` on macOS; `sudo apt install tmux` on Ubuntu/Debian). The terminal backend needs a Unix host; on Windows, run it inside WSL.

### Current Codex CLI compatibility

This checkout uses the [Codex app-server API](https://learn.chatgpt.com/docs/app-server),
and has been verified with Codex CLI 0.159.0. The old `codex proto` command is no longer used.
It supports streamed replies, follow-up turns, session resume, paginated transcripts,
and command/file/permission approval prompts. Sign in with `codex login` if needed.

Leave Model blank in Settings to use your installed Codex configuration's model.
Use **Save & Restart** to apply settings to an existing conversation. The default
sandbox is `workspace-write`, with approvals requested when needed. Unsupported
server requests produce an explicit error instead of hanging or being approved.

For this local installation, start with `sh start-local.sh` and open
`http://127.0.0.1:5055`. This launcher loads `.env` and requires Node.js 20.6+.
`npm start` and `node server.js` use exported environment variables instead.

### Setup
1. **Clone the repo:**
   ```bash
   git clone https://github.com/denpth/codex_webui.git
   cd codex_webui
   ```

2. **Install dependencies:**
   ```bash
   npm install
   ```

3. **Set up your env (optional but recommended):**
   ```bash
   cp .env.example .env
   # Tweak .env to your heart's content—ports, tokens, origins, oh my!
   ```

## Quick Start

### Terminal workspace and phones

The default **Terminal** view runs the native Codex CLI in a real PTY. The
conversation sidebar uses Codex's saved titles, with prompt context as a fallback.
On a phone, open the sidebar with **☰**. The screen adapts to the keyboard and
includes touch buttons for Escape, arrows, Enter, Tab, and Ctrl+C. You can type
directly into the terminal or use the message field below it.

- **Model** opens Codex's `/model` picker in the active conversation, including
  after a usage-limit error. Use the arrows and Enter to choose a model/effort;
  Codex also supports `s` to apply a choice only to this session.
- **Usage** opens `/usage`. Model changes cannot bypass an account-wide limit.
- Terminal runs with full filesystem access and approval policy `on-request`.
  This is access as the user running the server, not root privileges.
- Each live conversation runs one Codex process in a persistent tmux session.
  Each browser attaches through its own tmux client with its own screen size.
  Typing directly in either terminal appears live on the other connected devices.
  In **Wrap** mode, typing in the stable message field is shared live; **Send**
  submits it. Mobile keyboard composition and autocorrect preserve the field.
  In **Grid** mode, message drafts stay local until sent.
- The shared pane keeps the size it had when first opened. Connecting,
  disconnecting, rotating, or resizing another device does not resize Codex.
  Phones default to **Wrap**, which displays full logical lines at the device
  width with a visible scrollbar and 500 recent history lines. **Grid** retains
  the native terminal rendering; use **View** arrows to pan your own view, then
  **Follow cursor** to resume automatic tracking.
- Tap **Shift ⇧**, then **Tab**, **Enter**, or an arrow for that shifted binding.
  Shift resets after the next key.
- Browser disconnects and WebUI restarts detach clients while leaving Codex
  running. **Open terminals** recovers those sessions after restart. Explicitly
  closing a terminal stops Codex and disconnects every viewer of that terminal.
- Memory is bounded by eight sessions (including ended sessions until closed),
  32 browser clients, 10,000 history lines per pane, and 4 MiB of queued output
  per slow connection. Disconnected clients are released; no shared output replay
  buffer is retained in the WebUI server. Wrapped snapshots are bounded and
  shared per pane; unchanged snapshots are not retransmitted.
The browser uses the native terminal for conversations. The legacy chat HTTP API
remains available, but Codex permits only one active writer per conversation; close
its native terminal before resuming the same thread through that API.

The local installation is served privately through Tailscale at
`https://denniss-mac-mini.tail6e8371.ts.net:5055/`. The equivalent mapping is:

```sh
tailscale serve --bg --https=5055 http://127.0.0.1:5055
```

Terminal assets are served locally. WebSocket connections use short-lived,
single-use tickets issued by an authenticated same-origin POST; other websites
cannot open a terminal WebSocket through the browser. Keep the service on your
private tailnet. The terminal backend uses tmux, `node-pty`, `ws`, and xterm.js; run
`npm install` before starting it. The postinstall script fixes the executable
permission on node-pty's packaged Unix spawn helper when necessary.

### Option 1: npm Magic
```bash
npm start  # Fires up the server
# Or for dev mode with auto-reload (because who has time for manual restarts?):
npm run dev
```

### Option 2: Straight Node Vibes
```bash
# Run the server (defaults to localhost for safety)
HOST=127.0.0.1 PORT=5055 node server.js

# Pop open the UI in your browser
open http://127.0.0.1:5055   # macOS squad
start http://127.0.0.1:5055  # Windows warriors
xdg-open http://127.0.0.1:5055  # Linux legends
```

> Pro Tip: Exposing this externally? Set `ALLOW_ORIGIN` and `WEBUI_TOKEN` in your .env, or tunnel via SSH/Tailscale. Safety first—don't let randos mess with your Codex.

## Environment Variables
Check out `.env.example` for the full lineup. Customize ports, tokens, origins, and more to fit your setup.

## API Overview
Here's a quick hit list of endpoints to get you hacking:
- `GET /` — Serves up the static UI.
- `GET /events` — SSE stream for status, deltas, tools, and stderr.
- `POST /message` — Send user text (`{ text }`).
- `POST /approval` — Answer a pending approval (`{ id, decision: "accept" | "decline" }`) or question (`{ id, answers }`).
- `GET /sessions` — List all session files.
- `POST /resume` — Resume from a specific rollout (`{ path }`).
- `GET /session-messages` — Grab the last 100 messages from the current session.
- `GET /projects` — Session history grouped by workdir.
- `GET /memory` / `DELETE /memory` — Peek or purge memory facts.
- `GET /config` / `PUT /config` — Read/update whitelisted config keys.
- `POST /restart` — Restart Codex with the current resume.
- `POST /shutdown` — Politely tell Codex to call it a day.

📚 **[Full API Docs →](docs/API.md)** for the nitty-gritty details, params, and examples.

## Security Notes
- Binds to `127.0.0.1` by default—keeps things local and cozy.
- CORS locked to `http://localhost:PORT` out of the box.
- Going public? Flip on `WEBUI_TOKEN` for bearer auth on writes. Better safe than sorry!

## Documentation
We've got you covered with deeper dives in the `docs/` folder:
- **[Design Philosophy](docs/DESIGN.md)** - Why we built it this way (spoiler: simplicity wins).
- **[Technical Architecture](docs/ARCHITECTURE.md)** - Data flows, system guts, and how it all clicks.
- **[Comparison Guide](docs/COMPARISON.md)** - Vs. native CLI and other tools—spoiler: we win on usability.
- **[API Reference](docs/API.md)** - Every endpoint, event, and edge case.
- **[Development Guide](docs/DEVELOPMENT.md)** - Hacking, testing, and contributing tips.

## Contributing
Love it? Hate it? Got ideas? We're all ears! Check the [Development Guide](docs/DEVELOPMENT.md) for:
- Dev setup and code style.
- Testing rituals.
- PR etiquette.
Fork, tweak, and pull request away—let's make this even better together.

## License
MIT—free as in speech and beer. See `LICENSE` for the deets.
