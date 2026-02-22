#!/bin/bash
# Marks that a frontend file was edited

INPUT=$(cat)
FILE_PATH=$(echo "$INPUT" | jq -r '.tool_input.file_path // empty')

# Only mark frontend TypeScript files
if [[ "$FILE_PATH" == */frontend/src/*.ts ]] || [[ "$FILE_PATH" == */frontend/src/*.tsx ]]; then
  touch "$CLAUDE_PROJECT_DIR/.claude/claude.frontend-edited"
fi

exit 0
