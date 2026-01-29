import { IApplicationDefaults, IFramework } from "./types.mjs";
import { IVEContext } from "./backend-types.mjs";
import { IOciImageAnnotations } from "./types.mjs";
import { ExecutionMode, determineExecutionMode } from "./ve-execution/ve-execution-constants.mjs";
import { VeExecutionSshExecutor, SshExecutorDependencies } from "./ve-execution/ve-execution-ssh-executor.mjs";
import { VeExecutionMessageEmitter } from "./ve-execution/ve-execution-message-emitter.mjs";
import { OutputProcessor } from "./output-processor.mjs";
import { EventEmitter } from "events";
import { PersistenceManager } from "./persistence/persistence-manager.mjs";

export class FrameworkFromImage {
  /**
   * Executes a script on the VE host to extract OCI image annotations.
   * The script automatically checks if the image exists first (fast --raw check),
   * then performs full inspection if the image exists.
   * 
   * @param veContext VE context for SSH connection
   * @param image OCI image name (e.g., mariadb, ghcr.io/home-assistant/home-assistant)
   * @param tag Image tag (default: latest)
   * @param executionMode Optional execution mode (defaults to auto-detect)
   * @returns Extracted annotations
   * @throws Error with message containing "not found" or exit code 1 if image doesn't exist
   */
  static async getAnnotationsFromImage(
    veContext: IVEContext,
    image: string,
    tag: string = "latest",
    executionMode?: ExecutionMode,
  ): Promise<IOciImageAnnotations> {
    const scriptContent = this.getScriptContent();
    const mode = executionMode ?? determineExecutionMode();
    
    // Execute via SSH or locally based on execution mode
    // Script will be read from file system, template variables replaced, and executed via stdin
    const annotations = await this.executeOnVeHost(veContext, scriptContent, image, tag, mode);
    
    return annotations;
  }

  /**
   * Executes a script on the VE host via SSH or locally based on execution mode.
   * Script is read from file system, template variables are replaced, and then
   * executed via stdin (like templateprocessor does).
   */
  private static async executeOnVeHost(
    veContext: IVEContext,
    scriptContent: string,
    image: string,
    tag: string,
    executionMode: ExecutionMode,
  ): Promise<IOciImageAnnotations> {
    const interpreter = ["python3"];
    const timeoutMs = 60000; // 60 seconds
    
    // Replace template variables in script content: {{ image }}, {{ tag }}, {{ platform }}
    // We need to replace them in the argparse default values or in variable assignments
    // The script uses argparse, so we'll replace the values after parse_args() is called
    // Actually, better: replace the default values in the argparse.add_argument calls
    // Or even better: replace the variable assignments after parse_args()
    
    // Strategy: Replace template variables in the script content
    // The script will have lines like: image = args.image or image = "{{ image }}"
    // We replace {{ image }} with the actual value
    scriptContent = scriptContent.replace(/\{\{\s*image\s*\}\}/g, image);
    scriptContent = scriptContent.replace(/\{\{\s*tag\s*\}\}/g, tag);
    scriptContent = scriptContent.replace(/\{\{\s*platform\s*\}\}/g, "linux/amd64");
    
    // Also replace in argparse default values (in case they're used there)
    // This handles cases where the script has: parser.add_argument('--tag', default='{{ tag }}')
    // But our script doesn't use {{ }} in defaults, so this is just for safety
    
    // Create minimal dependencies for VeExecutionSshExecutor
    const eventEmitter = new EventEmitter();
    const messageEmitter = new VeExecutionMessageEmitter(eventEmitter);
    const outputs = new Map<string, string | number | boolean>();
    const defaults = new Map<string, string | number | boolean>();
    const outputProcessor = new OutputProcessor(outputs, undefined, defaults, executionMode);
    
    const deps: SshExecutorDependencies = {
      veContext: executionMode === ExecutionMode.PRODUCTION ? veContext : null,
      executionMode,
      scriptTimeoutMs: timeoutMs,
      messageEmitter,
      outputProcessor,
      outputsRaw: undefined,
      setOutputsRaw: () => {},
    };
    
    const sshExecutor = new VeExecutionSshExecutor(deps);
    
    // Build execution args (SSH args in production, interpreter args in test)
    const executionArgs = sshExecutor.buildExecutionArgs(interpreter);
    
    // Create a dummy command object for executeWithRetry
    const dummyCommand = {
      script: "get-oci-image-annotations.py",
      scriptContent,
    } as any;
    
    // Execute script via stdin (like templateprocessor does)
    const uniqueMarker = sshExecutor.createUniqueMarker();
    const result = await sshExecutor.executeWithRetry(
      executionArgs,
      scriptContent,
      timeoutMs,
      dummyCommand,
      scriptContent,
      interpreter,
      uniqueMarker,
    );
    
    if (result.exitCode !== 0) {
      // Check if error is "image not found" (exit code 1 from script)
      const errorMessage = result.stderr || result.stdout || "";
      if (result.exitCode === 1 && (errorMessage.includes("not found") || errorMessage.includes("Image"))) {
        throw new Error(`Image not found: ${errorMessage}`);
      }
      throw new Error(`Script failed with exit code ${result.exitCode}: ${result.stderr}`);
    }
    
    // Extract JSON from stdout (after marker)
    // The script outputs pure JSON, not name=value format
    // OutputProcessor strips the marker, but we need to get the JSON directly from stdout
    const markerIndex = result.stdout.indexOf(uniqueMarker);
    const jsonStart = markerIndex >= 0 ? markerIndex + uniqueMarker.length : 0;
    let jsonOutput = result.stdout.substring(jsonStart).trim();
    
    // Remove any leading/trailing whitespace or non-JSON content
    // The marker might be followed by newlines
    jsonOutput = jsonOutput.replace(/^\s*\n+/, "").trim();
    
    try {
      const annotations = JSON.parse(jsonOutput) as IOciImageAnnotations;
      return annotations;
    } catch (e) {
      throw new Error(`Failed to parse JSON output: ${e}. Output: ${jsonOutput}`);
    }
  }

  /**
   * Gets the path to the get-oci-image-annotations.py script.
   * Uses jsonPath from PersistenceManager, which can be configured during initialization.
   */
  private static getScriptContent(): string {
    const repositories = PersistenceManager.getInstance().getRepositories();
    const scriptContent = repositories.getScript({
      name: "get-oci-image-annotations.py",
      scope: "shared",
    });
    if (!scriptContent) {
      throw new Error("get-oci-image-annotations.py not found in shared scripts");
    }
    return scriptContent;
  }

  /**
   * Builds a pre-filled Framework object from OCI image annotations.
   * 
   * @param image OCI image name (e.g., "mariadb", "ghcr.io/home-assistant/home-assistant")
   * @param annotations Extracted annotations from image
   * @param baseApplicationId Base application ID to extend (default: "npm-nodejs")
   * @returns Pre-filled Framework object
   */
  static buildFrameworkFromAnnotations(
    image: string,
    annotations: IOciImageAnnotations,
    baseApplicationId: string = "npm-nodejs",
  ): IFramework {
    // Extract image name for framework name
    const imageName = image.split("/").pop()?.split(":")[0] || image;
    const frameworkName = imageName
      .split("-")
      .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
      .join(" ");
    
    const framework: IFramework = {
      id: frameworkName.toLowerCase().replace(/[^a-z0-9-]/g, "-"),
      name: frameworkName,
      extends: baseApplicationId,
      properties: [],
      ...(annotations.description && { description: annotations.description }),
      ...(annotations.url && { url: annotations.url }),
      ...(annotations.documentation && { documentation: annotations.documentation }),
      ...(annotations.source && { source: annotations.source }),
      ...(annotations.vendor && { vendor: annotations.vendor }),
    };
    
    return framework;
  }

  /**
   * Checks if a string is a valid hostname.
   * Valid hostname rules:
   * - Contains only alphanumeric characters, hyphens, and dots
   * - Does not start or end with hyphen or dot
   * - Each label (between dots) is max 63 characters
   * - Total length is max 253 characters
   */
  private static isValidHostname(hostname: string): boolean {
    if (!hostname || hostname.length === 0 || hostname.length > 253) {
      return false;
    }
    
    // Must not start or end with hyphen or dot
    if (hostname.startsWith("-") || hostname.startsWith(".") ||
        hostname.endsWith("-") || hostname.endsWith(".")) {
      return false;
    }
    
    // Split by dots and check each label
    const labels = hostname.split(".");
    for (const label of labels) {
      // Each label must be 1-63 characters
      if (label.length === 0 || label.length > 63) {
        return false;
      }
      // Each label must not start or end with hyphen
      if (label.startsWith("-") || label.endsWith("-")) {
        return false;
      }
      // Each label must contain only alphanumeric and hyphens
      if (!/^[a-z0-9-]+$/i.test(label)) {
        return false;
      }
    }
    
    return true;
  }

  /**
   * Builds application defaults from OCI image annotations.
   * 
   * @param image OCI image name (e.g., "mariadb", "ghcr.io/home-assistant/home-assistant")
   * @param annotations Extracted annotations from image
   * @returns Application defaults object
   */
  static buildApplicationDefaultsFromAnnotations(
    image: string,
    annotations: IOciImageAnnotations,
  ): IApplicationDefaults {
    // Extract image name for framework name
    const imageName = image.split("/").pop()?.split(":")[0] || image;
    const frameworkName = imageName
      .split("-")
      .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
      .join(" ");
    
    // Build defaults object
    const defaults: IApplicationDefaults = {
      applicationProperties: {
        name: frameworkName,
        applicationId: frameworkName.toLowerCase().replace(/[^a-z0-9-]/g, "-"),
        ...(annotations.description && { description: annotations.description }),
        ...(annotations.url && { url: annotations.url }),
        ...(annotations.documentation && { documentation: annotations.documentation }),
        ...(annotations.source && { source: annotations.source }),
        ...(annotations.vendor && { vendor: annotations.vendor }),
      },
      parameters: {},
    };
    
    // Add hostname if imageName (without transformation) is a valid hostname
    // Use imageName directly (e.g., "mariadb", "home-assistant") instead of frameworkName
    // which has spaces and capitalization
    if (this.isValidHostname(imageName)) {
      // Set hostname default value in parameters
      defaults.parameters = {
        ...defaults.parameters,
        hostname: imageName,
      };
    }
    
    return defaults;
  }
}

