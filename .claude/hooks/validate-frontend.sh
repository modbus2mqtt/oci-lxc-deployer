#!/bin/bash
# Validates frontend after changes: lint, build, test

MARKER="$CLAUDE_PROJECT_DIR/.claude/claude.frontend-edited"

if [ ! -f "$MARKER" ]; then
  exit 0
fi

rm -f "$MARKER"

cd "$CLAUDE_PROJECT_DIR/frontend" || exit 0

echo "=== Frontend: lint ===" >&2
npm run lint:fix 2>&1
LINT_EXIT=$?

echo "=== Frontend: build ===" >&2
npm run build 2>&1
BUILD_EXIT=$?

echo "=== Frontend: test ===" >&2
npm test 2>&1
TEST_EXIT=$?

if [ $LINT_EXIT -ne 0 ] || [ $BUILD_EXIT -ne 0 ] || [ $TEST_EXIT -ne 0 ]; then
  echo "" >&2
  echo "Frontend validation failed." >&2
  exit 1
fi

echo "=== Frontend: OK ===" >&2
exit 0
