#!/usr/bin/env node
/**
 * Syncs dependencies from backend/package.json to root package.json
 * and ensures package-lock.json is up to date.
 *
 * Fast path: If everything is in sync, exits immediately.
 * Slow path: If out of sync, repairs automatically.
 */

import { readFileSync, writeFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { spawnSync } from 'child_process';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const rootDir = join(__dirname, '..');

const backendPackageJsonPath = join(rootDir, 'backend', 'package.json');
const rootPackageJsonPath = join(rootDir, 'package.json');
const rootPackageLockPath = join(rootDir, 'package-lock.json');

// Read package files
const backendPackage = JSON.parse(readFileSync(backendPackageJsonPath, 'utf-8'));
const rootPackage = JSON.parse(readFileSync(rootPackageJsonPath, 'utf-8'));

// Fast check: Are dependencies already in sync?
const backendDeps = JSON.stringify(backendPackage.dependencies || {});
const rootDeps = JSON.stringify(rootPackage.dependencies || {});
const depsInSync = backendDeps === rootDeps;

// Fast check: Is package-lock.json in sync with package.json?
let lockInSync = false;
try {
  const lockFile = JSON.parse(readFileSync(rootPackageLockPath, 'utf-8'));
  const lockDeps = lockFile.packages?.['']?.dependencies || {};

  // Check if all root dependencies are in lock file with matching versions
  const rootDepsObj = rootPackage.dependencies || {};
  lockInSync = Object.keys(rootDepsObj).every(dep => {
    return lockDeps[dep] === rootDepsObj[dep];
  });
} catch {
  lockInSync = false;
}

// Fast path: Everything in sync
if (depsInSync && lockInSync) {
  console.error('✓ Dependencies in sync');
  process.exit(0);
}

// Slow path: Need to repair
console.error('Dependencies out of sync, repairing...');

// Step 1: Sync package.json
if (!depsInSync) {
  rootPackage.dependencies = { ...backendPackage.dependencies };
  writeFileSync(rootPackageJsonPath, JSON.stringify(rootPackage, null, 2) + '\n');
  console.error('✓ Synced dependencies from backend/package.json');
}

// Step 2: Update package-lock.json
console.error('Updating package-lock.json...');
const result = spawnSync('npm', ['install', '--package-lock-only'], {
  cwd: rootDir,
  stdio: 'inherit',
  shell: true
});

if (result.status === 0) {
  console.error('✓ Updated package-lock.json');
  process.exit(0);
} else {
  console.error('✗ Failed to update package-lock.json');
  process.exit(result.status || 1);
}
