import { randomBytes } from "node:crypto";

const DEFAULT_LENGTH = 32;
const CHARSET = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";

/**
 * Generates a cryptographically secure random secret.
 * Uses alphanumeric characters only for maximum compatibility
 * (works with Postgres, JWT, API keys, etc.)
 *
 * @param length - Length of the generated secret (default: 32, minimum: 16)
 * @returns A random alphanumeric string
 */
export function generateSecret(length: number = DEFAULT_LENGTH): string {
  const effectiveLength = Math.max(16, length);
  const bytes = randomBytes(effectiveLength);
  return Array.from(bytes, (b) => CHARSET[b % CHARSET.length]).join("");
}
