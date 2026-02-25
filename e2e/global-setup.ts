import { readFileSync, existsSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { ensureTestCerts } from './utils/cert-generator';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

interface BuildInfo {
  gitHash: string;
  buildTime: string;
  dirty: boolean;
}

/**
 * Playwright global setup: verify the running backend matches the local build.
 *
 * Compares backend/dist/build-info.json (written by postbuild) with /api/version
 * from the running server. Fails early if the backend needs a restart.
 */
export default async function globalSetup() {
  // Generate self-signed test certificates for HTTPS E2E tests (idempotent)
  ensureTestCerts();
  // Read local build info
  const buildInfoPath = join(__dirname, '..', 'backend', 'dist', 'build-info.json');
  if (!existsSync(buildInfoPath)) {
    console.warn('\n⚠ No backend/dist/build-info.json found. Run: cd backend && pnpm run build\n');
    return;
  }

  const localBuild: BuildInfo = JSON.parse(readFileSync(buildInfoPath, 'utf-8'));

  // Load E2E config to determine base URL
  const configPath = join(__dirname, 'config.json');
  const e2eConfig = JSON.parse(readFileSync(configPath, 'utf-8'));
  const instanceName = process.env.E2E_INSTANCE || e2eConfig.default;
  const instance = e2eConfig.instances[instanceName];
  const deployerPort = e2eConfig.ports.deployer + (instance?.portOffset || 0);

  // Determine which project is used
  const isLocal = process.argv.includes('--project=local');
  const frontendPort = process.env.FRONTEND_PORT || '4200';
  const baseURL = isLocal
    ? `http://localhost:${frontendPort}`
    : `http://${instance?.pveHost || 'localhost'}:${deployerPort}`;

  // Fetch version from running backend
  try {
    const response = await fetch(`${baseURL}/api/version`, { signal: AbortSignal.timeout(5000) });
    if (!response.ok) {
      console.warn(`\n⚠ /api/version returned ${response.status} - backend may need update\n`);
      return;
    }

    const remoteBuild: BuildInfo & { startTime: string } = await response.json();

    if (remoteBuild.gitHash !== localBuild.gitHash || remoteBuild.buildTime !== localBuild.buildTime) {
      const msg = [
        '',
        '╔══════════════════════════════════════════════════════════════╗',
        '║  BACKEND OUT OF DATE - restart required!                    ║',
        '╠══════════════════════════════════════════════════════════════╣',
        `║  Local build:  ${localBuild.gitHash} (${localBuild.buildTime.substring(0, 19)})`.padEnd(63) + '║',
        `║  Running:      ${remoteBuild.gitHash} (${remoteBuild.buildTime.substring(0, 19)})`.padEnd(63) + '║',
        `║  Server start: ${remoteBuild.startTime.substring(0, 19)}`.padEnd(63) + '║',
        '╚══════════════════════════════════════════════════════════════╝',
        '',
      ].join('\n');

      throw new Error(msg);
    }

    console.log(`✓ Backend version verified: ${remoteBuild.gitHash} (${remoteBuild.buildTime.substring(0, 19)})`);

    // Enable SSL for e2e tests (default is OFF, but tests expect cert generation)
    try {
      const sshRes = await fetch(`${baseURL}/api/sshconfigs`, { signal: AbortSignal.timeout(5000) });
      if (sshRes.ok) {
        const sshData = await sshRes.json();
        const veContextKey = sshData.key;
        if (veContextKey) {
          const sslUrl = `${baseURL}/api/ve/certificates/ssl/${veContextKey}`;
          const sslRes = await fetch(sslUrl, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ ssl_enabled: true }),
            signal: AbortSignal.timeout(5000),
          });
          if (sslRes.ok) {
            console.log(`✓ SSL enabled for e2e tests (veContext: ${veContextKey})`);
          } else {
            console.warn(`⚠ Could not enable SSL: ${sslRes.status}`);
          }
        }
      }
    } catch (sslErr: any) {
      console.warn(`⚠ Could not enable SSL for e2e tests: ${sslErr.message}`);
    }
  } catch (err: any) {
    if (err.message?.includes('BACKEND OUT OF DATE')) {
      throw err; // Re-throw our own error
    }
    console.warn(`\n⚠ Could not reach backend at ${baseURL}/api/version: ${err.message}\n`);
  }
}
