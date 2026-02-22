#!/bin/bash
# verify-build.sh - Verify frontend build after refactoring changes
# Usage: ./scripts/verify-build.sh

set -e

cd "$(dirname "$0")/.."

echo "=========================================="
echo "Frontend Build Verification"
echo "=========================================="

echo ""
echo "[1/3] Running lint:fix..."
pnpm run lint:fix
echo "✅ Lint passed"

echo ""
echo "[2/3] Running build..."
pnpm run build
echo "✅ Build passed"

echo ""
echo "[3/3] Running tests..."
pnpm test
echo "✅ Tests passed"

echo ""
echo "=========================================="
echo "✅ All verifications passed!"
echo "=========================================="
