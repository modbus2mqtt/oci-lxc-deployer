import { execSync, ExecSyncOptionsWithStringEncoding } from 'child_process';
import { getPveHost } from '../fixtures/test-base';
import {
  ValidationConfig,
  ContainerValidation,
  PortValidation,
  FileValidation,
  CommandValidation,
  ProcessValidation,
  VolumeValidation,
  UploadFileValidation,
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
    this.sshHost = options?.sshHost || getPveHost();
    this.sshPort = options?.sshPort || 1022;
    this.containerVmId = options?.containerVmId || '300';
    this.timeout = options?.timeout || 30000;
  }

  /**
   * Execute command on the PVE host via SSH (via stdin to avoid escaping issues)
   */
  execOnHost(command: string, timeout?: number): string {
    const sshCmd = [
      'ssh',
      '-o', 'StrictHostKeyChecking=no',
      '-o', 'UserKnownHostsFile=/dev/null',
      '-o', 'LogLevel=ERROR',
      '-p', String(this.sshPort),
      `root@${this.sshHost}`,
    ].join(' ');

    const options: ExecSyncOptionsWithStringEncoding = {
      timeout: timeout || this.timeout,
      encoding: 'utf-8',
      input: command,  // Pass command via stdin
    };

    return execSync(sshCmd, options);
  }

  /**
   * Execute command inside the LXC container via pct exec (Proxmox).
   * Note: This project runs OCI images directly in LXC (no Docker).
   * Pipes command via stdin to avoid escaping issues.
   */
  execInContainer(command: string, timeout?: number): string {
    // Pipe command via stdin to SSH -> pct exec -> sh
    // This avoids all shell escaping issues
    const sshCmd = [
      'ssh',
      '-o', 'StrictHostKeyChecking=no',
      '-o', 'UserKnownHostsFile=/dev/null',
      '-o', 'LogLevel=ERROR',
      '-p', String(this.sshPort),
      `root@${this.sshHost}`,
      `pct exec ${this.containerVmId} sh`,
    ].join(' ');

    console.log(`[execInContainer] VMID: ${this.containerVmId}`);
    console.log(`[execInContainer] Command: ${command}`);
    console.log(`[execInContainer] SSH command: ${sshCmd}`);

    const options: ExecSyncOptionsWithStringEncoding = {
      timeout: timeout || this.timeout,
      encoding: 'utf-8',
      input: command,  // Pass command via stdin
    };

    try {
      const output = execSync(sshCmd, options);
      console.log(`[execInContainer] Exit code: 0`);
      console.log(`[execInContainer] Output: "${output.substring(0, 200)}${output.length > 200 ? '...' : ''}"`);
      return output;
    } catch (error: unknown) {
      const execError = error as { status?: number; stderr?: Buffer; stdout?: Buffer; message?: string };
      console.log(`[execInContainer] Exit code: ${execError.status}`);
      console.log(`[execInContainer] Error: ${execError.message}`);
      if (execError.stderr) {
        console.log(`[execInContainer] Stderr: ${execError.stderr.toString().substring(0, 200)}`);
      }
      throw error;
    }
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
      // Read /proc/net/tcp(6) inside container, grep on PVE host
      // Port in /proc/net/tcp is in hex, state 0A = LISTEN
      const portHex = port.port.toString(16).toUpperCase().padStart(4, '0');
      const procFile = protocol === 'tcp' ? '/proc/net/tcp' : '/proc/net/udp';
      // Check both IPv4 and IPv6
      this.execOnHost(`pct exec ${this.containerVmId} -- cat ${procFile} ${procFile}6 2>/dev/null | grep -qi ":${portHex} "`);

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
   * Delete a directory on the PVE host (with rm -rf)
   * Returns true if deleted or didn't exist, false on error
   */
  deleteDirectoryOnHost(path: string): { success: boolean; message: string } {
    try {
      this.execOnHost(`rm -rf "${path}"`);
      return {
        success: true,
        message: `Directory ${path} deleted (or didn't exist)`,
      };
    } catch (error) {
      return {
        success: false,
        message: `Failed to delete ${path}: ${error}`,
      };
    }
  }

  /**
   * Validate that a file exists on the PVE host (not in container)
   */
  validateFileOnHost(file: FileValidation): ValidationResult {
    try {
      this.execOnHost(`test -f "${file.path}"`);

      if (file.contentPattern) {
        const content = this.execOnHost(`cat "${file.path}"`);
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
        message: `File ${file.path} exists on host`,
      };
    } catch {
      return {
        success: false,
        message: `File ${file.path} does not exist on host`,
      };
    }
  }

  /**
   * Validate that a file exists inside the container (and optionally matches content pattern)
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
      // Replace {vmId} placeholder and choose execution target
      const resolvedCommand = cmd.command.replace(/\{vmId\}/g, this.containerVmId);
      const output = cmd.executeOn === 'host'
        ? this.execOnHost(resolvedCommand)
        : this.execInContainer(resolvedCommand);

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
   * Validate that a process is running and optionally check its UID.
   * Runs inside the LXC container (OCI image).
   */
  validateProcess(proc: ProcessValidation): ValidationResult {
    const description = proc.description || `Process '${proc.name}' is running`;

    try {
      // Run ps inside container, pipe to grep on PVE host (minimal OCI images don't have grep)
      const psOutput = this.execOnHost(`pct exec ${this.containerVmId} -- ps aux 2>/dev/null | grep -E "${proc.name}" | grep -v grep || true`);
      const lines = psOutput.trim().split('\n').filter(Boolean);

      if (lines.length === 0 || (lines.length === 1 && lines[0].trim() === '')) {
        return {
          success: false,
          message: `${description} - process not found`,
        };
      }

      // Parse the first matching process to get PID
      // BusyBox ps format: PID USER TIME COMMAND
      const firstLine = lines[0].trim();
      const parts = firstLine.split(/\s+/);
      const pid = parts[0];

      // Get actual UID from /proc/PID/status
      // Run cat inside container, grep on PVE host
      let actualUid: number | undefined;
      if (pid && proc.expectedUid !== undefined) {
        try {
          const uidOutput = this.execOnHost(`pct exec ${this.containerVmId} -- cat /proc/${pid}/status | grep "^Uid:" | awk '{print $2}'`);
          actualUid = parseInt(uidOutput.trim(), 10);
        } catch {
          // If we can't get UID, continue without it
        }
      }

      // Check UID if expected
      if (proc.expectedUid !== undefined) {
        if (actualUid === undefined || isNaN(actualUid)) {
          return {
            success: false,
            message: `${description} - could not determine UID`,
            details: psOutput,
          };
        }
        if (actualUid !== proc.expectedUid) {
          return {
            success: false,
            message: `${description} - running as UID ${actualUid}, expected ${proc.expectedUid}`,
            details: psOutput,
          };
        }
      }

      return {
        success: true,
        message: proc.expectedUid !== undefined
          ? `${description} (UID ${actualUid})`
          : description,
      };
    } catch (error) {
      return {
        success: false,
        message: `${description} - check failed: ${error}`,
      };
    }
  }

  /**
   * Validate volume permissions and ownership.
   * Runs inside the LXC container (OCI image).
   */
  validateVolume(vol: VolumeValidation): ValidationResult {
    const description = vol.description || `Volume '${vol.path}' has correct permissions`;

    try {
      // Check if directory exists inside LXC container
      this.execInContainer(`test -d "${vol.path}"`);

      // Get owner UID using stat
      const statOutput = this.execInContainer(`stat -c '%u' "${vol.path}" 2>/dev/null || stat -f '%u' "${vol.path}"`);
      const actualUid = parseInt(statOutput.trim(), 10);

      // Check UID if expected
      if (vol.expectedUid !== undefined && actualUid !== vol.expectedUid) {
        return {
          success: false,
          message: `${description} - owned by UID ${actualUid}, expected ${vol.expectedUid}`,
        };
      }

      // Check read access for the expected UID
      if (vol.checkReadable && vol.expectedUid !== undefined) {
        const permOutput = this.execInContainer(`stat -c '%a' "${vol.path}" 2>/dev/null || stat -f '%Lp' "${vol.path}"`);
        const perms = parseInt(permOutput.trim(), 8);
        const ownerRead = (perms & 0o400) !== 0;
        const groupRead = (perms & 0o040) !== 0;
        const otherRead = (perms & 0o004) !== 0;

        const canRead = (actualUid === vol.expectedUid && ownerRead) || otherRead || groupRead;
        if (!canRead) {
          return {
            success: false,
            message: `${description} - UID ${vol.expectedUid} cannot read (perms: ${permOutput.trim()})`,
          };
        }
      }

      // Check write access for the expected UID
      if (vol.checkWritable && vol.expectedUid !== undefined) {
        const permOutput = this.execInContainer(`stat -c '%a' "${vol.path}" 2>/dev/null || stat -f '%Lp' "${vol.path}"`);
        const perms = parseInt(permOutput.trim(), 8);
        const ownerWrite = (perms & 0o200) !== 0;
        const groupWrite = (perms & 0o020) !== 0;
        const otherWrite = (perms & 0o002) !== 0;

        const canWrite = (actualUid === vol.expectedUid && ownerWrite) || otherWrite || groupWrite;
        if (!canWrite) {
          return {
            success: false,
            message: `${description} - UID ${vol.expectedUid} cannot write (perms: ${permOutput.trim()})`,
          };
        }
      }

      return {
        success: true,
        message: vol.expectedUid !== undefined
          ? `${description} (UID ${actualUid})`
          : description,
      };
    } catch {
      return {
        success: false,
        message: `${description} - directory does not exist or check failed`,
      };
    }
  }

  /**
   * Validate upload file exists with correct content and ownership.
   * Runs inside the LXC container (OCI image).
   */
  validateUploadFile(upload: UploadFileValidation): ValidationResult {
    const description = upload.description || `Upload file '${upload.path}' exists`;

    try {
      // Check if file exists inside LXC container
      this.execInContainer(`test -f "${upload.path}"`);

      // Check owner UID if expected
      if (upload.expectedUid !== undefined) {
        const statOutput = this.execInContainer(`stat -c '%u' "${upload.path}" 2>/dev/null || stat -f '%u' "${upload.path}"`);
        const actualUid = parseInt(statOutput.trim(), 10);

        if (actualUid !== upload.expectedUid) {
          return {
            success: false,
            message: `${description} - owned by UID ${actualUid}, expected ${upload.expectedUid}`,
          };
        }
      }

      // Check content if expected
      if (upload.expectedContent) {
        const content = this.execInContainer(`cat "${upload.path}"`);

        if (upload.isRegex) {
          if (!new RegExp(upload.expectedContent).test(content)) {
            return {
              success: false,
              message: `${description} - content does not match pattern`,
              details: content.substring(0, 500),
            };
          }
        } else {
          // Exact match (trimmed)
          if (content.trim() !== upload.expectedContent.trim()) {
            return {
              success: false,
              message: `${description} - content mismatch`,
              details: `Expected: ${upload.expectedContent.substring(0, 200)}\nActual: ${content.substring(0, 200)}`,
            };
          }
        }
      }

      return {
        success: true,
        message: description,
      };
    } catch {
      return {
        success: false,
        message: `${description} - file does not exist`,
      };
    }
  }

  /**
   * Find and destroy old LXC containers with the same hostname, keeping the newly created one.
   * Also cleans up volume directories of destroyed containers.
   *
   * Safety: Only runs when deployerStaticIp is in 10.0.0.* subnet (test environment).
   *
   * @param hostname - Container hostname (the "Name" column in pct list)
   * @param keepVmId - VMID of the newly created container to keep (use '0' to destroy all)
   * @param deployerStaticIp - Deployer's static IP from config (for safety check)
   * @returns Summary of destroyed containers
   */
  cleanupOldContainers(
    hostname: string,
    keepVmId: string,
    deployerStaticIp: string,
  ): { success: boolean; destroyed: string[]; message: string } {
    // Safety check: only run in test environments
    const ipWithoutCidr = deployerStaticIp.split('/')[0];
    if (!ipWithoutCidr.startsWith('10.0.0.')) {
      const msg = `Safety check: deployerStaticIp="${deployerStaticIp}" is not in 10.0.0.* subnet. Skipping container cleanup.`;
      console.log(`[cleanupOldContainers] ${msg}`);
      return { success: true, destroyed: [], message: msg };
    }

    const DEPLOYER_VMID = '300';
    const destroyed: string[] = [];

    try {
      const pctOutput = this.execOnHost('pct list').trim();
      const lines = pctOutput.split('\n').slice(1); // Skip header line

      // Find containers with matching hostname
      const oldVmIds: string[] = [];
      for (const line of lines) {
        const parts = line.trim().split(/\s+/);
        if (parts.length < 3) continue;
        const vmId = parts[0];
        const name = parts[parts.length - 1]; // Name is always the last column

        if (name.toLowerCase() === hostname.toLowerCase()
            && vmId !== keepVmId
            && vmId !== DEPLOYER_VMID) {
          oldVmIds.push(vmId);
        }
      }

      if (oldVmIds.length === 0) {
        const msg = `No old containers found with hostname "${hostname}" (keeping ${keepVmId})`;
        console.log(`[cleanupOldContainers] ${msg}`);
        return { success: true, destroyed: [], message: msg };
      }

      console.log(`[cleanupOldContainers] Found ${oldVmIds.length} old container(s) with hostname "${hostname}": ${oldVmIds.join(', ')}`);

      // Collect volume directories before destroying
      const volumeDirs: string[] = [];

      for (const vmId of oldVmIds) {
        try {
          const config = this.execOnHost(`pct config ${vmId}`);
          for (const match of config.matchAll(/mp\d+:\s*([^,]+),mp=/g)) {
            const hostPath = match[1].trim();
            const parentDir = hostPath.replace(/\/[^/]+$/, '');
            if (!volumeDirs.includes(parentDir)) {
              volumeDirs.push(parentDir);
            }
          }
        } catch {
          console.log(`[cleanupOldContainers] Could not read config for ${vmId} - continuing with destroy`);
        }

        this.execOnHost(`pct stop ${vmId} 2>/dev/null || true`);
        this.execOnHost(`pct destroy ${vmId} --purge 2>/dev/null || true`);
        destroyed.push(vmId);
        console.log(`[cleanupOldContainers] Destroyed container ${vmId} (hostname: ${hostname})`);
      }

      // Clean up volume directories
      for (const dir of volumeDirs) {
        try {
          this.execOnHost(`rm -rf "${dir}"`);
          console.log(`[cleanupOldContainers] Deleted volume directory: ${dir}`);
        } catch {
          console.log(`[cleanupOldContainers] Failed to delete volume directory: ${dir}`);
        }
      }

      const msg = `Destroyed ${destroyed.length} old container(s) with hostname "${hostname}": ${destroyed.join(', ')}`;
      console.log(`[cleanupOldContainers] ${msg}`);
      return { success: true, destroyed, message: msg };
    } catch (error) {
      const msg = `Failed to cleanup old containers for "${hostname}": ${error}`;
      console.log(`[cleanupOldContainers] ${msg}`);
      return { success: false, destroyed, message: msg };
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

    // Validate processes
    if (config.processes) {
      for (const proc of config.processes) {
        console.log(`Validating process: ${proc.name}`);
        results.push(this.validateProcess(proc));
      }
    }

    // Validate volumes
    if (config.volumes) {
      for (const vol of config.volumes) {
        console.log(`Validating volume: ${vol.path}`);
        results.push(this.validateVolume(vol));
      }
    }

    // Validate upload files
    if (config.uploadFiles) {
      for (const upload of config.uploadFiles) {
        console.log(`Validating upload file: ${upload.path}`);
        results.push(this.validateUploadFile(upload));
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
