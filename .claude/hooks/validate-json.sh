#!/bin/bash
# Validates JSON files at end of Claude response (Stop hook)
# Only runs if mark-json-edit.sh marked that JSON files were edited

MARKER="$CLAUDE_PROJECT_DIR/.claude/claude.json-edited"

# Only validate if marker exists (JSON was edited)
if [ ! -f "$MARKER" ]; then
  exit 0
fi

# Remove marker
rm -f "$MARKER"

# Check if backend/dist exists
if [ ! -d "$CLAUDE_PROJECT_DIR/backend/dist" ]; then
  echo "Backend not built - skipping validation" >&2
  exit 0
fi

# Run validation
cd "$CLAUDE_PROJECT_DIR/backend" && node dist/oci-lxc-deployer.mjs validate 2>&1

if [ $? -eq 0 ]; then
  exit 0
else
  echo "" >&2
  echo "JSON validation failed. Please fix the errors above." >&2
  exit 1
fi
