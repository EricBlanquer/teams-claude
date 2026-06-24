# teams-claude

Embed a Claude Code terminal directly inside Microsoft Teams for Linux.

![Teams with Claude Terminal](https://raw.githubusercontent.com/ebmusic/teams-claude/main/screenshot.png)

## How it works

1. The script launches Teams for Linux with `--remote-debugging-port=9333` (Chrome DevTools Protocol)
2. It downloads [xterm.js](https://xtermjs.org/) and injects it into the Teams UI via CDP `Runtime.evaluate` (bypasses Content Security Policy)
3. The xterm.js terminal connects via WebSocket to [Claude Code UI](https://github.com/siteboon/claudecodeui) which manages PTY sessions
4. Claude Code starts with a system prompt that tells it it's running inside Teams and can control the UI via the [chrome-devtools MCP](https://github.com/nicedoc/teams-for-linux)
5. Claude can read conversations, type messages, take screenshots, and interact with the Teams UI

## Prerequisites

1. **Teams for Linux** (deb or flatpak): https://github.com/nicedoc/teams-for-linux/releases
2. **Claude Code UI** (WebSocket PTY backend): https://github.com/siteboon/claudecodeui
3. **Claude Code CLI**: `~/.local/bin/claude`
4. **Chrome DevTools MCP** configured in `~/.claude/settings.json`:
   ```json
   {
     "mcpServers": {
       "chrome-devtools": {
         "command": "npx",
         "args": ["chrome-devtools-mcp@latest", "--browserUrl", "http://127.0.0.1:9333"]
       }
     }
   }
   ```
5. **Python 3** with the `websockets` module (`pip install websockets`)

## Usage

```bash
# Normal mode
./teams-claude.sh

# Bypass permissions (no confirmation prompts)
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
| `teams-claude.sh` | Main script — launches Teams, injects xterm.js terminal, starts Claude Code |
| `teams-claude-skip-permissions.sh` | Shortcut — runs the main script with `--dangerously-skip-permissions` |
| `teams-claude.md` | System prompt for Claude (Teams formatting rules, behavior guidelines) |

## Features

- Terminal panel embedded in the Teams conversation area (not an overlay)
- Resizable by dragging the top edge
- Panel height saved in localStorage across sessions
- Image paste from clipboard (saved to `/tmp/` and path sent to Claude)
- Graceful Teams shutdown (saves window position/size)
- Auto-detection of Teams installation (deb or flatpak)
- Background injection (Teams is usable while the terminal loads)
- **Dedicated project directory** — Claude runs from `~/teams-claude` with its own `CLAUDE.md` for Teams-specific instructions
- **Session continuity** — uses `--continue` to resume the previous conversation automatically
- **Relaunch after Ctrl+C** — typing `claude` in the terminal relaunches with all Teams flags and session resume (via a bash alias in `/tmp/teams-bashrc`)
