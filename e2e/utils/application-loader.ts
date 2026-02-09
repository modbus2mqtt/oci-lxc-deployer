import { readdirSync, existsSync, readFileSync, statSync } from 'fs';
import { join, resolve, dirname } from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

/**
 * Upload file definition
 */
export interface UploadFile {
  filename: string;
  destination: string; // "config:path" or "secure:path"
}

/**
 * Container validation configuration
 */
export interface ContainerValidation {
  /** Image name (partial match) */
  image: string;
  /** Expected container state */
  state?: 'running';
}

/**
 * Port validation configuration
 */
export interface PortValidation {
  /** Port number to check */
  port: number;
  /** Protocol (default: tcp) */
  protocol?: 'tcp' | 'udp';
  /** Service name for error messages */
  service?: string;
}

/**
 * File validation configuration
 */
export interface FileValidation {
  /** Path to file inside container */
  path: string;
  /** Regex pattern to match file content */
  contentPattern?: string;
}

/**
 * Command validation configuration
 */
export interface CommandValidation {
  /** Command to execute in container */
  command: string;
  /** Expected exit code (default: 0) */
  expectedExitCode?: number;
  /** Regex pattern to match output */
  expectedOutput?: string;
  /** Human-readable description */
  description?: string;
}

/**
 * Validation configuration for post-install checks
 */
export interface ValidationConfig {
  /** Seconds to wait before running validations */
  waitBeforeValidation?: number;
  /** Docker containers that should be running */
  containers?: ContainerValidation[];
  /** Ports that should be listening */
  ports?: PortValidation[];
  /** Files that should exist */
  files?: FileValidation[];
  /** Custom commands to execute */
  commands?: CommandValidation[];
}

/**
 * E2E Application definition
 */
export interface E2EApplication {
  /** Application name (from appconf.json or directory name) */
  name: string;
  /** Absolute path to application directory */
  directory: string;
  /** Optional description */
  description?: string;
  /** Tags for categorization (must match tags defined in json/tags.json) */
  tags?: string[];
  /** Task type for special handling (e.g., postgres setup) */
  tasktype?: 'default' | 'postgres';
  /** Absolute path to icon file (svg preferred, then png) */
  icon?: string;
  /** Absolute path to docker-compose file */
  dockerCompose?: string;
  /** Absolute path to .env file */
  envFile?: string;
  /** Files to upload to container */
  uploadfiles?: UploadFile[];
  /** Validation configuration for post-install checks */
  validation?: ValidationConfig;
}

/**
 * Application configuration from appconf.json
 */
interface AppConf {
  name?: string;
  description?: string;
  tags?: string[];
  tasktype?: 'default' | 'postgres';
  uploadfiles?: UploadFile[];
  validation?: ValidationConfig;
}

/**
 * Loads E2E test applications from a directory.
 *
 * File discovery conventions:
 * - Icon: icon.svg > icon.png > *.svg > *.png
 * - Docker Compose: *.yml or *.yaml
 * - Environment: *.env
 * - Config: appconf.json (optional)
 */
export class E2EApplicationLoader {
  private basePath: string;

  constructor(basePath: string) {
    this.basePath = resolve(basePath);
  }

  /**
   * Load all applications from the base directory
   */
  async loadAll(): Promise<E2EApplication[]> {
    const entries = readdirSync(this.basePath, { withFileTypes: true });
    const apps: E2EApplication[] = [];

    for (const entry of entries) {
      if (entry.isDirectory()) {
        const app = await this.load(entry.name);
        apps.push(app);
      }
    }

    return apps.sort((a, b) => a.name.localeCompare(b.name));
  }

  /**
   * Load a single application by name
   */
  async load(appName: string): Promise<E2EApplication> {
    const appDir = join(this.basePath, appName);

    if (!existsSync(appDir) || !statSync(appDir).isDirectory()) {
      throw new Error(`Application directory not found: ${appDir}`);
    }

    // Load optional appconf.json
    const appConf = this.loadAppConf(appDir);

    return {
      name: appConf?.name || appName,
      directory: appDir,
      description: appConf?.description,
      tags: appConf?.tags,
      tasktype: appConf?.tasktype,
      icon: this.findIcon(appDir),
      dockerCompose: this.findDockerCompose(appDir),
      envFile: this.findEnvFile(appDir),
      uploadfiles: appConf?.uploadfiles,
      validation: appConf?.validation,
    };
  }

  /**
   * Load appconf.json if it exists
   */
  private loadAppConf(dir: string): AppConf | undefined {
    const confPath = join(dir, 'appconf.json');
    if (!existsSync(confPath)) {
      return undefined;
    }

    try {
      const content = readFileSync(confPath, 'utf-8');
      return JSON.parse(content) as AppConf;
    } catch (error) {
      console.warn(`Failed to parse appconf.json in ${dir}:`, error);
      return undefined;
    }
  }

  /**
   * Find icon file with priority: icon.svg > icon.png > *.svg > *.png
   */
  private findIcon(dir: string): string | undefined {
    // Check for standard names first
    const iconSvg = join(dir, 'icon.svg');
    if (existsSync(iconSvg)) return iconSvg;

    const iconPng = join(dir, 'icon.png');
    if (existsSync(iconPng)) return iconPng;

    // Find any SVG file
    const files = readdirSync(dir);
    const svgFile = files.find((f) => f.endsWith('.svg'));
    if (svgFile) return join(dir, svgFile);

    // Find any PNG file
    const pngFile = files.find((f) => f.endsWith('.png'));
    if (pngFile) return join(dir, pngFile);

    return undefined;
  }

  /**
   * Find docker-compose file (*.yml or *.yaml)
   */
  private findDockerCompose(dir: string): string | undefined {
    const files = readdirSync(dir);

    // Find any .yml or .yaml file (typically docker-compose)
    const composeFile = files.find(
      (f) =>
        (f.endsWith('.yml') || f.endsWith('.yaml')) &&
        !f.startsWith('.')
    );

    return composeFile ? join(dir, composeFile) : undefined;
  }

  /**
   * Find .env file
   */
  private findEnvFile(dir: string): string | undefined {
    const files = readdirSync(dir);

    const envFile = files.find((f) => f.endsWith('.env'));
    return envFile ? join(dir, envFile) : undefined;
  }
}

/**
 * Default loader instance for e2e/applications
 */
export const defaultLoader = new E2EApplicationLoader(
  join(__dirname, '../applications')
);
