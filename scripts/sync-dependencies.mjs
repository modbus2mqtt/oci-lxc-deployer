#!/usr/bin/env node
/**
 * Syncs dependencies from backend/package.json to root package.json
 * and ensures all package-lock.json files are up to date.
 *
 * Fast path: If everything is in sync, exits immediately (~30ms).
 * Slow path: If out of sync, repairs automatically.
 */

import { readFileSync, writeFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { spawnSync } from 'child_process';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const rootDir = join(__dirname, '..');

// Project directories
const projects = [
  { name: 'root', dir: rootDir },
  { name: 'backend', dir: join(rootDir, 'backend') },
  { name: 'frontend', dir: join(rootDir, 'frontend') }
];

/**
 * Fast check: Is package-lock.json in sync with package.json?
 * Compares direct dependencies only (not transitive).
 */
function isLockInSync(projectDir) {
  try {
    const pkgPath = join(projectDir, 'package.json');
    const lockPath = join(projectDir, 'package-lock.json');

    const pkg = JSON.parse(readFileSync(pkgPath, 'utf-8'));
    const lock = JSON.parse(readFileSync(lockPath, 'utf-8'));

    const pkgDeps = pkg.dependencies || {};
    const pkgDevDeps = pkg.devDependencies || {};
    const lockDeps = lock.packages?.['']?.dependencies || {};
    const lockDevDeps = lock.packages?.['']?.devDependencies || {};

    // Check dependencies
    const depsMatch = Object.keys(pkgDeps).every(dep => lockDeps[dep] === pkgDeps[dep]);
    const devDepsMatch = Object.keys(pkgDevDeps).every(dep => lockDevDeps[dep] === pkgDevDeps[dep]);

    return depsMatch && devDepsMatch;
  } catch {
    return false;
  }
}

/**
 * Repair package-lock.json by running npm install --package-lock-only
 */
function repairLock(projectName, projectDir) {
  console.error(`Updating ${projectName}/package-lock.json...`);
  const result = spawnSync('npm', ['install', '--package-lock-only'], {
    cwd: projectDir,
    stdio: 'inherit',
    shell: true
  });

  if (result.status === 0) {
    console.error(`✓ Updated ${projectName}/package-lock.json`);
    return true;
  } else {
    console.error(`✗ Failed to update ${projectName}/package-lock.json`);
    return false;
  }
}

// --- Main ---

// Check 1: Are root dependencies synced from backend?
const backendPkgPath = join(rootDir, 'backend', 'package.json');
const rootPkgPath = join(rootDir, 'package.json');

const backendPkg = JSON.parse(readFileSync(backendPkgPath, 'utf-8'));
const rootPkg = JSON.parse(readFileSync(rootPkgPath, 'utf-8'));

const backendDeps = JSON.stringify(backendPkg.dependencies || {});
const rootDeps = JSON.stringify(rootPkg.dependencies || {});
const rootDepsInSync = backendDeps === rootDeps;

// Check 2: Are all lock files in sync?
const lockStatus = projects.map(p => ({
  ...p,
  inSync: isLockInSync(p.dir)
}));

const allLocksInSync = lockStatus.every(p => p.inSync);

// Fast path: Everything in sync
if (rootDepsInSync && allLocksInSync) {
  console.error('✓ All dependencies in sync');
  process.exit(0);
}

// Slow path: Need to repair
console.error('Dependencies out of sync, repairing...');
let hasError = false;

// Step 1: Sync root package.json from backend
if (!rootDepsInSync) {
  rootPkg.dependencies = { ...backendPkg.dependencies };
  writeFileSync(rootPkgPath, JSON.stringify(rootPkg, null, 2) + '\n');
  console.error('✓ Synced root dependencies from backend/package.json');
  // Mark root lock as needing repair since we changed package.json
  const rootStatus = lockStatus.find(p => p.name === 'root');
  if (rootStatus) rootStatus.inSync = false;
}

// Step 2: Repair any out-of-sync lock files
for (const project of lockStatus) {
  if (!project.inSync) {
    if (!repairLock(project.name, project.dir)) {
      hasError = true;
    }
  }
}

if (hasError) {
  process.exit(1);
} else {
  console.error('✓ All dependencies repaired');
  process.exit(0);
}
