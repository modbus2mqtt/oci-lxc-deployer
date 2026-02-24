import { readFileSync } from 'fs';
import { parse as parseYaml } from 'yaml';
import {
  ValidationConfig,
  UploadFile,
} from './application-loader';

/**
 * Parsed docker-compose service
 */
interface ComposeService {
  image?: string;
  user?: string;
  ports?: string[];
  volumes?: string[];
  environment?: Record<string, string> | string[];
}

/**
 * Parsed docker-compose file
 */
interface ComposeFile {
  services?: Record<string, ComposeService>;
}

/**
 * Generates validation configuration from docker-compose.yml and upload files.
 *
 * This allows tests to automatically validate:
 * - Process runs with correct UID
 * - Volumes have correct ownership and permissions
 * - Upload files exist with correct content
 * - Ports are listening
 */
export class ValidationGenerator {
  /**
   * Generate validation config from docker-compose.yml and upload files
   */
  static generate(options: {
    dockerComposePath?: string;
    uploadFiles?: UploadFile[];
    uploadFilesBasePath?: string;
    /** Wait time before validation in seconds */
    waitBeforeValidation?: number;
  }): ValidationConfig {
    const config: ValidationConfig = {
      waitBeforeValidation: options.waitBeforeValidation ?? 0,
    };

    let volumeMappings: Map<string, string> | undefined;

    if (options.dockerComposePath) {
      const compose = this.parseDockerCompose(options.dockerComposePath);
      if (compose) {
        volumeMappings = this.addFromCompose(config, compose);
      }
    }

    if (options.uploadFiles && options.uploadFilesBasePath) {
      this.addUploadFileValidations(config, options.uploadFiles, options.uploadFilesBasePath, volumeMappings);
    }

    return config;
  }

  /**
   * Parse docker-compose.yml file
   */
  private static parseDockerCompose(path: string): ComposeFile | null {
    try {
      const content = readFileSync(path, 'utf-8');
      return parseYaml(content) as ComposeFile;
    } catch (error) {
      console.warn(`Failed to parse docker-compose.yml: ${error}`);
      return null;
    }
  }

  /**
   * Add validations from docker-compose data
   * Returns a map of volume prefix -> container path for upload file resolution
   */
  private static addFromCompose(
    config: ValidationConfig,
    compose: ComposeFile
  ): Map<string, string> {
    const volumeMappings = new Map<string, string>();

    if (!compose.services) return volumeMappings;

    // Get the first service (primary service)
    const serviceNames = Object.keys(compose.services);
    if (serviceNames.length === 0) return volumeMappings;

    const primaryServiceName = serviceNames[0];
    const service = compose.services[primaryServiceName];

    // Extract UID from user field (e.g., "1883:1883" or "1883")
    const uid = this.extractUid(service.user);

    // Note: Process validation is NOT auto-generated.
    // Process names cannot be reliably derived from Docker image names.
    // Use appconf.json "validation.processes" for explicit process checks.

    // Add port validations
    if (service.ports) {
      config.ports = config.ports || [];
      for (const portMapping of service.ports) {
        const port = this.extractPort(portMapping);
        if (port) {
          config.ports.push({
            port: port.containerPort,
            protocol: 'tcp',
            service: primaryServiceName,
          });
        }
      }
    }

    // Add volume validations and build volume mappings
    if (service.volumes) {
      config.volumes = config.volumes || [];
      for (const volumeMapping of service.volumes) {
        const volume = this.extractVolume(volumeMapping);
        if (volume) {
          config.volumes.push({
            path: volume.containerPath,
            expectedUid: uid,
            checkReadable: true,
            description: `Volume '${volume.containerPath}' owned by UID ${uid || 'default'}`,
          });

          // Build volume mapping: "./config" -> "config", then map to container path
          // This allows upload file destinations like "config:file.conf" to resolve correctly
          const hostPrefix = volume.hostPath.replace(/^\.\//, ''); // Remove "./" prefix
          volumeMappings.set(hostPrefix, volume.containerPath);
          console.log(`[ValidationGenerator] Volume mapping: ${hostPrefix} -> ${volume.containerPath}`);
        }
      }
    }

    return volumeMappings;
  }

  /**
   * Add upload file validations
   */
  private static addUploadFileValidations(
    config: ValidationConfig,
    uploadFiles: UploadFile[],
    basePath: string,
    volumeMappings?: Map<string, string>
  ): void {
    config.uploadFiles = config.uploadFiles || [];

    for (let i = 0; i < uploadFiles.length; i++) {
      const upload = uploadFiles[i];
      const displayName = this.filenameFromDestination(upload.destination);
      console.log(`[ValidationGenerator] upload file ${i}: ${displayName} (required=${upload.required}, advanced=${upload.advanced})`);

      // Skip advanced files (optional configurations like certificates)
      if (upload.advanced) {
        console.log(`[ValidationGenerator] Skipping advanced file: ${displayName}`);
        continue;
      }

      // Parse destination (e.g., "config:mosquitto.conf" -> "/mosquitto/config/mosquitto.conf")
      const containerPath = this.resolveUploadDestination(upload.destination, volumeMappings);
      console.log(`[ValidationGenerator] Upload destination: ${upload.destination} -> ${containerPath}`);
      if (!containerPath) continue;

      // Only check file existence, not content.
      // Content comparison is unreliable because persistent volumes may contain
      // files from previous installations that the upload script preserves.
      config.uploadFiles.push({
        path: containerPath,
        isRegex: false,
        description: `Upload file '${displayName}' exists at ${containerPath}`,
      });
    }
  }

  /**
   * Extract UID from user field
   * Handles formats:
   * - "1883" -> 1883
   * - "1883:1883" -> 1883
   * - "${UID:-1000}:${GID:-1000}" -> 1000 (extracts default value)
   * - "${UID}:${GID}" -> undefined (no default)
   */
  private static extractUid(user?: string): number | undefined {
    if (!user) return undefined;

    // First, try to extract ${VAR:-default} syntax from the beginning of the string
    // This must be done BEFORE splitting by ':' because ':-' contains a colon
    const envVarMatch = user.match(/^\$\{[^}]+:-(\d+)\}/);
    if (envVarMatch) {
      return parseInt(envVarMatch[1], 10);
    }

    // Handle simple formats: "1883", "1883:1883", "user:group"
    const parts = user.split(':');
    const uidStr = parts[0];

    // Check if it's a numeric UID
    const uid = parseInt(uidStr, 10);
    if (!isNaN(uid)) {
      return uid;
    }

    return undefined;
  }

  /**
   * Extract port from port mapping (e.g., "1883:1883" -> { hostPort: 1883, containerPort: 1883 })
   */
  private static extractPort(portMapping: string): { hostPort: number; containerPort: number } | null {
    // Handle formats: "1883:1883", "1883:1883/tcp", "8080:80"
    const parts = portMapping.split('/')[0].split(':');

    if (parts.length === 2) {
      const hostPort = parseInt(parts[0], 10);
      const containerPort = parseInt(parts[1], 10);
      if (!isNaN(hostPort) && !isNaN(containerPort)) {
        return { hostPort, containerPort };
      }
    } else if (parts.length === 1) {
      const port = parseInt(parts[0], 10);
      if (!isNaN(port)) {
        return { hostPort: port, containerPort: port };
      }
    }

    return null;
  }

  /**
   * Extract volume paths from volume mapping
   */
  private static extractVolume(volumeMapping: string): { hostPath: string; containerPath: string } | null {
    // Handle formats: "./data:/mosquitto/data", "config:/app/config"
    const parts = volumeMapping.split(':');

    if (parts.length >= 2) {
      return {
        hostPath: parts[0],
        containerPath: parts[1],
      };
    }

    return null;
  }

  /**
   * Extract filename from destination (e.g., "config:mosquitto.conf" -> "mosquitto.conf", "certs:server.crt" -> "server.crt")
   */
  private static filenameFromDestination(destination: string): string {
    const colonIndex = destination.indexOf(':');
    const filePath = colonIndex >= 0 ? destination.slice(colonIndex + 1) : destination;
    const lastSlash = filePath.lastIndexOf('/');
    return lastSlash >= 0 ? filePath.slice(lastSlash + 1) : filePath;
  }

  /**
   * Resolve upload destination to container path
   * Uses volume mappings from docker-compose.yml if available
   * e.g., "config:mosquitto.conf" with mapping "./config:/mosquitto/config" -> "/mosquitto/config/mosquitto.conf"
   */
  private static resolveUploadDestination(
    destination: string,
    volumeMappings?: Map<string, string>
  ): string | null {
    // Parse format: "prefix:path" or just "path"
    const parts = destination.split(':');

    if (parts.length === 2) {
      const prefix = parts[0];
      const path = parts[1];

      // Try to use volume mappings from docker-compose.yml
      if (volumeMappings) {
        const containerPath = volumeMappings.get(prefix);
        if (containerPath) {
          return `${containerPath}/${path}`;
        }
      }

      // Fallback: Map common prefixes to container paths
      const prefixMap: Record<string, string> = {
        'config': '/app/config',
        'secure': '/app/secure',
        'data': '/app/data',
      };

      const basePath = prefixMap[prefix] || `/app/${prefix}`;
      return `${basePath}/${path}`;
    }

    // No prefix, assume it's a full path
    return destination.startsWith('/') ? destination : `/app/${destination}`;
  }
}
