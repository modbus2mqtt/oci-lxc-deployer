#!/bin/bash
# Rollback script: pnpm → npm
# Use this if pnpm causes problems

set -e

RED='\033[0;31m'
GREEN='\033[0;32m'
BLUE='\033[0;34m'
NC='\033[0m'

echo "${BLUE}=== Rollback to npm ===${NC}"

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
cd "$PROJECT_ROOT"

# Step 1: Remove pnpm files
echo "${BLUE}Step 1: Removing pnpm files...${NC}"
rm -f pnpm-lock.yaml backend/pnpm-lock.yaml frontend/pnpm-lock.yaml
rm -f .npmrc
echo "${GREEN}✓ pnpm files removed${NC}"

# Step 2: Remove node_modules
echo "${BLUE}Step 2: Removing node_modules...${NC}"
rm -rf node_modules backend/node_modules frontend/node_modules
echo "${GREEN}✓ node_modules removed${NC}"

# Step 3: Restore package.json scripts
echo "${BLUE}Step 3: Restoring package.json scripts...${NC}"
# This uses git to restore the original
git checkout HEAD -- package.json 2>/dev/null || echo "Warning: Could not restore package.json from git"

# Step 4: Restore workflows
echo "${BLUE}Step 4: Restoring workflows...${NC}"
git checkout HEAD -- .github/workflows/ 2>/dev/null || echo "Warning: Could not restore workflows from git"

# Step 5: Restore other files
echo "${BLUE}Step 5: Restoring other files...${NC}"
git checkout HEAD -- scripts/sync-dependencies.mjs 2>/dev/null || true
git checkout HEAD -- .gitignore 2>/dev/null || true

# Step 6: Install with npm
echo "${BLUE}Step 6: Installing with npm...${NC}"
npm install
(cd backend && npm install)
(cd frontend && npm install)

echo ""
echo "${GREEN}=== Rollback complete! ===${NC}"
echo "You are now back to npm."
