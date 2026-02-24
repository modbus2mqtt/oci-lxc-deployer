import { existsSync, mkdirSync } from 'fs';
import { join, dirname } from 'path';
import { execSync } from 'child_process';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const CERTS_DIR = join(__dirname, '..', 'certs');
const CERT_PATH = join(CERTS_DIR, 'server.crt');
const KEY_PATH = join(CERTS_DIR, 'server.key');

/**
 * Ensure self-signed test certificates exist for HTTPS E2E tests.
 *
 * Generates server.crt + server.key in e2e/certs/ via openssl CLI.
 * SAN: DNS:localhost, IP:127.0.0.1 | Validity: 3650 days | No passphrase.
 * Idempotent: skips generation if both files already exist.
 */
export function ensureTestCerts(): void {
  if (existsSync(CERT_PATH) && existsSync(KEY_PATH)) {
    console.log('✓ Test certificates already exist');
    return;
  }

  mkdirSync(CERTS_DIR, { recursive: true });

  console.log('Generating self-signed test certificates...');

  execSync(
    [
      'openssl req -x509 -newkey rsa:2048 -nodes',
      `-keyout "${KEY_PATH}"`,
      `-out "${CERT_PATH}"`,
      '-days 3650',
      '-subj "/CN=localhost"',
      '-addext "subjectAltName=DNS:localhost,IP:127.0.0.1"',
    ].join(' '),
    { stdio: 'pipe' }
  );

  console.log('✓ Test certificates generated in e2e/certs/');
}
