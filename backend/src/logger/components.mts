/**
 * Logger component names for debug filtering.
 * Use these constants when creating loggers to ensure consistency.
 *
 * Enable debug logging via environment variable:
 *   DEBUG_COMPONENTS=ssh,execution
 *
 * Or via API at runtime:
 *   GET /api/logger/debug-components?components=ssh,execution
 */
export const LogComponents = {
  /** SSH connection and command execution */
  SSH: "ssh",
  /** Script and template execution */
  EXECUTION: "execution",
  /** Web application and routes */
  WEBAPP: "webapp",
  /** Context storage and persistence */
  CONTEXT: "context",
  /** Main application lifecycle */
  MAIN: "main",
} as const;

export type LogComponent = (typeof LogComponents)[keyof typeof LogComponents];
