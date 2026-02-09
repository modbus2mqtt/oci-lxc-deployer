import { execSync, ExecSyncOptionsWithStringEncoding } from 'child_process';
import { SSH_HOST } from '../fixtures/test-base';
import {
  ValidationConfig,
  ContainerValidation,
  PortValidation,
  FileValidation,
  CommandValidation,
} from './application-loader';

/**
 * Result of a single validation check
 */
export interface ValidationResult {
  success: boolean;
  message: string;
  details?: string;
}

/**
 * Options for SSHValidator
 */
export interface SSHValidatorOptions {
  /** SSH host (default: SSH_HOST from fixtures) */
  sshHost?: string;
  /** SSH port (default: 1022) */
  sshPort?: number;
  /** Container VMID to execute commands in (default: 300) */
  containerVmId?: string;
  /** Command timeout in ms (default: 30000) */
  timeout?: number;
}

/**
 * SSH-based validator for post-installation checks.
 *
 * Executes commands via SSH to the PVE host, then uses `pct exec` to run
 * commands inside the deployer container.
 *
 * @example
 * ```typescript
 * const validator = new SSHValidator({ sshHost: 'ubuntupve', sshPort: 1022 });
 * const results = await validator.runValidations(app.validation);
 * ```
 */
export class SSHValidator {
  private sshHost: string;
  private sshPort: number;
  private containerVmId: string;
  private timeout: number;

  constructor(options?: SSHValidatorOptions) {
    this.sshHost = options?.sshHost || SSH_HOST;
    this.sshPort = options?.sshPort || 1022;
    this.containerVmId = options?.containerVmId || '300';
    this.timeout = options?.timeout || 30000;
  }

  /**
   * Execute command on the PVE host via SSH
   */
  private execOnHost(command: string, timeout?: number): string {
    const sshCmd = [
      'ssh',
      '-o', 'StrictHostKeyChecking=no',
      '-o', 'UserKnownHostsFile=/dev/null',
      '-o', 'LogLevel=ERROR',
      '-p', String(this.sshPort),
      `root@${this.sshHost}`,
      command,
    ].join(' ');

    const options: ExecSyncOptionsWithStringEncoding = {
      timeout: timeout || this.timeout,
      encoding: 'utf-8',
      stdio: ['pipe', 'pipe', 'pipe'],
    };

    return execSync(sshCmd, options);
  }

  /**
   * Execute command inside the container via pct exec
   */
  execInContainer(command: string, timeout?: number): string {
    // Escape the command for shell
    const escapedCmd = command.replace(/'/g, "'\\''");
    return this.execOnHost(`pct exec ${this.containerVmId} -- sh -c '${escapedCmd}'`, timeout);
  }

  /**
   * Wait for specified seconds
   */
  async wait(seconds: number): Promise<void> {
    await new Promise((resolve) => setTimeout(resolve, seconds * 1000));
  }

  /**
   * Validate that a Docker container is running
   */
  validateContainer(container: ContainerValidation): ValidationResult {
    try {
      const output = this.execInContainer('docker ps --format "{{.Image}} {{.State}}"');
      const lines = output.trim().split('\n').filter(Boolean);

      for (const line of lines) {
        const parts = line.split(' ');
        const image = parts[0] || '';
        const state = parts[1] || '';

        const imageMatches = image.includes(container.image);
        const stateMatches = !container.state || state === container.state;

        if (imageMatches && stateMatches) {
          return {
            success: true,
            message: `Container with image '${container.image}' is ${state}`,
          };
        }
      }

      return {
        success: false,
        message: `Container with image '${container.image}' not found or not in expected state`,
        details: output,
      };
    } catch (error) {
      return {
        success: false,
        message: `Failed to check container '${container.image}': ${error}`,
      };
    }
  }

  /**
   * Validate that a port is listening
   */
  validatePort(port: PortValidation): ValidationResult {
    try {
      const protocol = port.protocol || 'tcp';
      const checkCmd =
        protocol === 'tcp'
          ? `ss -tln | grep -q ":${port.port} "`
          : `ss -uln | grep -q ":${port.port} "`;

      this.execInContainer(checkCmd);

      const serviceName = port.service ? ` (${port.service})` : '';
      return {
        success: true,
        message: `Port ${port.port}/${protocol} is listening${serviceName}`,
      };
    } catch {
      const serviceName = port.service ? ` (${port.service})` : '';
      return {
        success: false,
        message: `Port ${port.port} is not listening${serviceName}`,
      };
    }
  }

  /**
   * Validate that a file exists (and optionally matches content pattern)
   */
  validateFile(file: FileValidation): ValidationResult {
    try {
      this.execInContainer(`test -f "${file.path}"`);

      if (file.contentPattern) {
        const content = this.execInContainer(`cat "${file.path}"`);
        if (!new RegExp(file.contentPattern).test(content)) {
          return {
            success: false,
            message: `File ${file.path} content does not match pattern '${file.contentPattern}'`,
            details: content.substring(0, 500),
          };
        }
      }

      return {
        success: true,
        message: `File ${file.path} exists`,
      };
    } catch {
      return {
        success: false,
        message: `File ${file.path} does not exist`,
      };
    }
  }

  /**
   * Validate a custom command execution
   */
  validateCommand(cmd: CommandValidation): ValidationResult {
    const description = cmd.description || `Command: ${cmd.command}`;

    try {
      const output = this.execInContainer(cmd.command);

      if (cmd.expectedOutput && !new RegExp(cmd.expectedOutput).test(output)) {
        return {
          success: false,
          message: `${description} - output mismatch`,
          details: output.substring(0, 500),
        };
      }

      return {
        success: true,
        message: description,
      };
    } catch (error: unknown) {
      const execError = error as { status?: number; message?: string };
      const exitCode = execError.status;

      // Check if the exit code matches expected (useful for commands that return non-zero on success)
      if (cmd.expectedExitCode !== undefined && exitCode === cmd.expectedExitCode) {
        return {
          success: true,
          message: `${description} - exited with expected code ${exitCode}`,
        };
      }

      // Default expectation is exit code 0
      if (cmd.expectedExitCode === undefined && exitCode === 0) {
        return {
          success: true,
          message: description,
        };
      }

      return {
        success: false,
        message: `${description} - failed with exit code ${exitCode}`,
        details: execError.message,
      };
    }
  }

  /**
   * Run all validations from a ValidationConfig
   */
  async runValidations(config: ValidationConfig): Promise<ValidationResult[]> {
    const results: ValidationResult[] = [];

    // Wait before validation if specified
    if (config.waitBeforeValidation && config.waitBeforeValidation > 0) {
      console.log(`Waiting ${config.waitBeforeValidation}s before validation...`);
      await this.wait(config.waitBeforeValidation);
    }

    // Validate containers
    if (config.containers) {
      for (const container of config.containers) {
        console.log(`Validating container: ${container.image}`);
        results.push(this.validateContainer(container));
      }
    }

    // Validate ports
    if (config.ports) {
      for (const port of config.ports) {
        console.log(`Validating port: ${port.port}`);
        results.push(this.validatePort(port));
      }
    }

    // Validate files
    if (config.files) {
      for (const file of config.files) {
        console.log(`Validating file: ${file.path}`);
        results.push(this.validateFile(file));
      }
    }

    // Validate commands
    if (config.commands) {
      for (const cmd of config.commands) {
        console.log(`Validating command: ${cmd.description || cmd.command}`);
        results.push(this.validateCommand(cmd));
      }
    }

    return results;
  }

  /**
   * Run validations and return summary
   */
  async validate(config: ValidationConfig): Promise<{
    success: boolean;
    results: ValidationResult[];
    summary: string;
  }> {
    const results = await this.runValidations(config);
    const passed = results.filter((r) => r.success).length;
    const failed = results.filter((r) => !r.success).length;
    const success = failed === 0;

    return {
      success,
      results,
      summary: `${passed} passed, ${failed} failed`,
    };
  }
}
