#!/bin/bash
# Compatibility launcher; permissions use the regular Codex configuration.
exec "$(dirname "$0")/teams-claude.sh" "$@"
