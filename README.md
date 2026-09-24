# Teams assistant terminal

Embed Claude Code and Codex CLI terminals directly inside Microsoft Teams for Linux, with a button to switch between them.

![Teams with Codex Terminal](https://raw.githubusercontent.com/ebmusic/teams-claude/main/screenshot.png)

## How it works

1. The script launches Teams for Linux with `--remote-debugging-port=9333` (Chrome DevTools Protocol)
2. It downloads [xterm.js](https://xtermjs.org/) and injects it into the Teams UI via CDP `Runtime.evaluate` (bypasses Content Security Policy)
3. The xterm.js terminal connects via WebSocket to the bundled `terminal_server.py`, which provides a local PTY session
4. The selected assistant starts with Teams-specific instructions and a per-session [Chrome DevTools MCP](https://github.com/ChromeDevTools/chrome-devtools-mcp) configuration targeting port 9333
5. Both assistants can read conversations, type messages, take screenshots, and interact with the Teams UI

Before anything else, the launcher fast-forwards the repository (`git pull --ff-only`, 30 s timeout) and re-execs itself when the pull brought new commits, so a machine always starts the latest version. It starts the local terminal backend and Teams, then injects the terminal when the backend and Teams page are ready. If the backend fails to start, Teams remains usable and the error is written to `~/.cache/teams-claude/terminal-server.log`.

## Prerequisites

1. **Teams for Linux** (deb or flatpak): https://github.com/nicedoc/teams-for-linux/releases
2. **Codex CLI** available as `codex` and **Claude Code** as `claude` on `PATH`, authenticated with their usual settings
3. **Node.js/npm** so the launcher can run `chrome-devtools-mcp` through `npx`
4. **Python 3** with the `websockets` module (`pip install websockets`)

## Usage

```bash
# Normal mode
./teams-claude.sh

# Custom local terminal port
TEAMS_TERMINAL_PORT=4000 ./teams-claude.sh

# Skip the startup auto-update
TEAMS_CLAUDE_AUTO_PULL=0 ./teams-claude.sh
```

## Desktop integration (replace the Teams launcher)

To make the Teams menu entry and autostart launch the script instead of plain Teams, point their `Exec` to it:

- `~/.local/share/applications/teams-for-linux.desktop` — menu launcher override
- `~/.config/autostart/teams-for-linux.desktop` — autostart at login

```ini
Exec=/home/eric/teams-claude/teams-claude.sh %U
```

**Cinnamon gotcha**: the Cinnamon menu (cinnamon-menus) resolves duplicate desktop-file IDs to the *last* `<AppDir>` in the menu definition, which makes `/usr/share/applications` win over the local override. Fix it by declaring the local directory as the last root-level `<AppDir>` in `~/.config/menus/cinnamon-applications.menu`:

```xml
<MergeFile type="parent">/etc/xdg/menus/cinnamon-applications.menu</MergeFile>
<AppDir>/home/eric/.local/share/applications</AppDir>
```

Then restart Cinnamon (`Ctrl+Alt+Esc`). Verify which file the menu resolves with:

```bash
dbus-send --session --print-reply --dest=org.Cinnamon /org/Cinnamon org.Cinnamon.Eval \
  string:'Cinnamon.AppSystem.get_default().lookup_app("teams-for-linux.desktop").get_app_info().get_commandline()'
```

## Keyboard shortcuts (inside Teams)

| Shortcut | Action |
|----------|--------|
| `Ctrl+`` | Toggle terminal panel |
| `Ctrl+V` | Paste (supports images from clipboard) |
| `Tab` | Autocompletion (focus stays in terminal) |
| `Alt+Up` | Open a pending Codex question or edit a queued message |

The **Answer** button in the Codex terminal header performs the same action without holding Alt.
The terminal sends Alt+Up explicitly because xterm.js otherwise maps it to Ctrl+Up on Linux.

## Files

| File | Description |
|------|-------------|
| `teams-claude.sh` | Main script — launches Teams, injects the xterm.js terminal, and starts the selected assistant; the legacy filename is kept for desktop-entry compatibility |
| `teams-claude-skip-permissions.sh` | Compatibility shortcut to `teams-claude.sh`; uses the regular Codex permission settings |
| `terminal_server.py` | Local WebSocket PTY backend for the embedded terminal |
| `teams-codex.md` | Shared Teams instructions, passed as Codex developer instructions or appended to the Claude Code system prompt |
| `terminal.js` | Embedded terminal UI and assistant switching |

## Features

- **Auto-update at launch** — fast-forward pull then restart when new commits arrived; a failed or diverged pull only prints a warning and keeps the local version (`TEAMS_CLAUDE_AUTO_PULL=0` disables it)
- Terminal panel embedded in the Teams conversation area (not an overlay)
- Resizable by dragging the top edge
- Panel height saved in localStorage across sessions
- Image paste from clipboard (saved to `/tmp/` and path sent to Codex)
- Graceful Teams shutdown (saves window position/size)
- Auto-detection of Teams installation (deb or flatpak)
- Background injection (Teams is usable while the terminal loads)
- Local terminal backend bound to `127.0.0.1` with the Teams web origin required for WebSocket connections
- **Home directory** — new Claude and Codex conversations start from `~` with Teams-specific instructions
- **Assistant switch** — click `Claude` or `Codex` in the header to show that assistant. Each has its own terminal and conversation; switching keeps both sessions alive, including unfinished input. Histories are separate and are not transferred between assistants. The selected assistant is remembered for the next launch.
- **Session controls** — `+` starts a new conversation for the displayed assistant; reconnect resumes its latest conversation in the current directory
- **Relaunch after Ctrl+C** — typing `codex` in the terminal relaunches with the Teams prompt and MCP configuration through `/tmp/teams-codex`

Both assistants use their regular permission settings, including when resuming a session. Claude Code receives the same Teams instructions and Chrome DevTools endpoint as Codex.

Validation: `python3 -m unittest terminal_server_test.py`, `node --test terminal.test.cjs`, and `bash -n teams-claude.sh`.
