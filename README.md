# Teams Codex terminal

Embed a Codex CLI terminal directly inside Microsoft Teams for Linux.

![Teams with Codex Terminal](https://raw.githubusercontent.com/ebmusic/teams-claude/main/screenshot.png)

## How it works

1. The script launches Teams for Linux with `--remote-debugging-port=9333` (Chrome DevTools Protocol)
2. It downloads [xterm.js](https://xtermjs.org/) and injects it into the Teams UI via CDP `Runtime.evaluate` (bypasses Content Security Policy)
3. The xterm.js terminal connects via WebSocket to [Claude Code UI](https://github.com/siteboon/claudecodeui), which provides the PTY session
4. [Codex CLI](https://developers.openai.com/codex/cli/) starts with Teams-specific developer instructions and a per-session [Chrome DevTools MCP](https://github.com/ChromeDevTools/chrome-devtools-mcp) configuration targeting port 9333
5. Codex can read conversations, type messages, take screenshots, and interact with the Teams UI

## Prerequisites

1. **Teams for Linux** (deb or flatpak): https://github.com/nicedoc/teams-for-linux/releases
2. **Claude Code UI** (WebSocket PTY backend): https://github.com/siteboon/claudecodeui
3. **Codex CLI** available as `codex` on `PATH`
4. **Node.js/npm** so the launcher can run `chrome-devtools-mcp` through `npx`
5. **Python 3** with the `websockets` module (`pip install websockets`)

## Usage

```bash
# Normal mode
./teams-claude.sh

# Bypass approvals and sandboxing (no confirmation prompts)
./teams-claude-skip-permissions.sh

# Custom Claude Code UI port
CLAUDECODEUI_PORT=4000 ./teams-claude.sh
```

## Desktop integration (replace the Teams launcher)

To make the Teams menu entry and autostart launch the script instead of plain Teams, point their `Exec` to it:

- `~/.local/share/applications/teams-for-linux.desktop` — menu launcher override
- `~/.config/autostart/teams-for-linux.desktop` — autostart at login

```ini
Exec=/home/eric/teams-claude/teams-claude-skip-permissions.sh %U
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

## Files

| File | Description |
|------|-------------|
| `teams-claude.sh` | Main script — launches Teams, injects the xterm.js terminal, and starts Codex; the legacy filename is kept for desktop-entry compatibility |
| `teams-claude-skip-permissions.sh` | Shortcut — runs Codex with `--dangerously-bypass-approvals-and-sandbox` |
| `teams-codex.md` | Developer instructions for Codex (Teams formatting rules and behavior guidelines) |

## Features

- Terminal panel embedded in the Teams conversation area (not an overlay)
- Resizable by dragging the top edge
- Panel height saved in localStorage across sessions
- Image paste from clipboard (saved to `/tmp/` and path sent to Codex)
- Graceful Teams shutdown (saves window position/size)
- Auto-detection of Teams installation (deb or flatpak)
- Background injection (Teams is usable while the terminal loads)
- **Dedicated project directory** — Codex starts from `~/teams-claude` with Teams-specific developer instructions
- **Session controls** — the `+` button starts a new conversation and reconnect resumes the latest Codex session for the current directory
- **Relaunch after Ctrl+C** — typing `codex` in the terminal relaunches with the Teams prompt and MCP configuration through `/tmp/teams-codex`

The skip-permissions launcher disables Codex approvals and sandboxing. Use it only in an environment where that level of access is intended.
