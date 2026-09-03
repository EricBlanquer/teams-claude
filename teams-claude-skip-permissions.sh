#!/bin/bash
# Launch Teams for Linux with Codex terminal (bypass permissions enabled)
exec "$(dirname "$0")/teams-claude.sh" --dangerously-bypass-approvals-and-sandbox "$@"
