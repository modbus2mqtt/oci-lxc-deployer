#!/bin/bash
# Validates backend after changes: lint, build, test

MARKER="$CLAUDE_PROJECT_DIR/.claude/claude.backend-edited"

if [ ! -f "$MARKER" ]; then
  exit 0
fi

rm -f "$MARKER"

cd "$CLAUDE_PROJECT_DIR/backend" || exit 0

echo "=== Backend: lint ===" >&2
npm run lint:fix 2>&1
LINT_EXIT=$?

echo "=== Backend: build ===" >&2
npm run build 2>&1
BUILD_EXIT=$?

echo "=== Backend: test ===" >&2
npm test 2>&1
TEST_EXIT=$?

if [ $LINT_EXIT -ne 0 ] || [ $BUILD_EXIT -ne 0 ] || [ $TEST_EXIT -ne 0 ]; then
  echo "" >&2
  echo "Backend validation failed." >&2
  exit 1
fi

echo "=== Backend: OK ===" >&2
exit 0
