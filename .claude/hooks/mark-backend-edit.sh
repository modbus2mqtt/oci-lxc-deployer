#!/bin/bash
# Marks that a backend file was edited

INPUT=$(cat)
FILE_PATH=$(echo "$INPUT" | jq -r '.tool_input.file_path // empty')

# Only mark backend TypeScript files
if [[ "$FILE_PATH" == */backend/src/*.mts ]] || [[ "$FILE_PATH" == */backend/src/*.ts ]]; then
  touch "$CLAUDE_PROJECT_DIR/.claude/claude.backend-edited"
fi

exit 0
