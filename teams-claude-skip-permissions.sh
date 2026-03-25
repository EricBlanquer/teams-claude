#!/bin/bash
# Launch Teams for Linux with Claude Code terminal (bypass permissions enabled)
exec "$(dirname "$0")/teams-claude.sh" --dangerously-skip-permissions "$@"
