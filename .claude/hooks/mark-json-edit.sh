#!/bin/bash
# Marks that a JSON file was edited (for later validation at Stop)

INPUT=$(cat)
FILE_PATH=$(echo "$INPUT" | jq -r '.tool_input.file_path // empty')

# Only mark relevant JSON files
if [[ "$FILE_PATH" == *json/*.json ]] || [[ "$FILE_PATH" == *schemas/*.json ]] || [[ "$FILE_PATH" == *examples/*.json ]]; then
  touch "$CLAUDE_PROJECT_DIR/.claude/claude.json-edited"
fi

exit 0
