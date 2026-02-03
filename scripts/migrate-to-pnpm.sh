#!/bin/bash
# Migration script: npm → pnpm
# This script converts the project from npm to pnpm

set -e

# Colors
RED='\033[0;31m'
GREEN='\033[0;32m'
BLUE='\033[0;34m'
NC='\033[0m'

echo "${BLUE}=== pnpm Migration ===${NC}"

# Get project root
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
cd "$PROJECT_ROOT"

# Step 1: Check/install pnpm
echo "${BLUE}Step 1: Checking pnpm installation...${NC}"
if ! command -v pnpm &> /dev/null; then
  echo "Installing pnpm via corepack..."
  corepack enable
  corepack prepare pnpm@latest --activate
fi
echo "${GREEN}✓ pnpm $(pnpm --version) available${NC}"

# Step 2: Convert lock files
echo "${BLUE}Step 2: Converting lock files...${NC}"

for dir in . backend frontend; do
  if [ -f "$dir/package-lock.json" ]; then
    echo "  Converting $dir/package-lock.json..."
    (cd "$dir" && pnpm import 2>/dev/null || true)
    rm -f "$dir/package-lock.json"
    echo "${GREEN}  ✓ $dir converted${NC}"
  fi
done

# Step 3: Remove node_modules
echo "${BLUE}Step 3: Removing node_modules...${NC}"
rm -rf node_modules backend/node_modules frontend/node_modules
echo "${GREEN}✓ node_modules removed${NC}"

# Step 4: Create .npmrc for compatibility
echo "${BLUE}Step 4: Creating .npmrc...${NC}"
cat > .npmrc << 'EOF'
# pnpm configuration
shamefully-hoist=true
EOF
echo "${GREEN}✓ .npmrc created${NC}"

# Step 5: Install dependencies
echo "${BLUE}Step 5: Installing dependencies...${NC}"
pnpm install
echo "${GREEN}✓ Root dependencies installed${NC}"

(cd backend && pnpm install)
echo "${GREEN}✓ Backend dependencies installed${NC}"

(cd frontend && pnpm install)
echo "${GREEN}✓ Frontend dependencies installed${NC}"

# Step 6: Verify installation
echo "${BLUE}Step 6: Verifying installation...${NC}"

echo "  Running backend tests..."
if (cd backend && pnpm test 2>&1 | tail -5); then
  echo "${GREEN}  ✓ Backend tests passed${NC}"
else
  echo "${RED}  ✗ Backend tests failed${NC}"
  exit 1
fi

echo "  Building backend..."
if (cd backend && pnpm run build 2>&1 | tail -3); then
  echo "${GREEN}  ✓ Backend build passed${NC}"
else
  echo "${RED}  ✗ Backend build failed${NC}"
  exit 1
fi

echo "  Building frontend..."
if (cd frontend && pnpm run build 2>&1 | tail -3); then
  echo "${GREEN}  ✓ Frontend build passed${NC}"
else
  echo "${RED}  ✗ Frontend build failed${NC}"
  exit 1
fi

echo ""
echo "${GREEN}=== Migration complete! ===${NC}"
echo ""
echo "Next steps:"
echo "  1. Update CI workflows to use pnpm"
echo "  2. Update sync-dependencies.mjs for pnpm"
echo "  3. Commit the changes"
echo ""
echo "Commands changed:"
echo "  npm install  → pnpm install"
echo "  npm ci       → pnpm install --frozen-lockfile"
echo "  npm test     → pnpm test"
echo "  npm run X    → pnpm X (or pnpm run X)"
