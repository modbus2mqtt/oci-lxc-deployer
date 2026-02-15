import path from "path";
import fs from "fs";
import { ApplicationLoader } from "./apploader.mjs";
import {
  IConfiguredPathes,
  VEConfigurationError,
  IReadApplicationOptions,
} from "./backend-types.mjs";
import {
  IFramework,
  TaskType,
  IParameter,
  IParameterValue,
  IPostFrameworkCreateApplicationBody,
  IFrameworkApplicationDataBody,
  IUploadFile,
} from "./types.mjs";
import { StorageContext } from "./storagecontext.mjs";
import { ContextManager } from "./context-manager.mjs";
import { JsonError } from "./jsonvalidator.mjs";
import { TemplateProcessor } from "./templates/templateprocessor.mjs";
import { IVEContext } from "./backend-types.mjs";
import {
  IFrameworkPersistence,
  IApplicationPersistence,
  ITemplatePersistence,
} from "./persistence/interfaces.mjs";
import { PersistenceManager } from "./persistence/persistence-manager.mjs";

export interface IReadFrameworkOptions {
  framework?: IFramework;
  frameworkPath?: string;
  error: VEConfigurationError;
}

export class FrameworkLoader {
  constructor(
    private pathes: IConfiguredPathes,
    private storage:
      | StorageContext
      | ContextManager = StorageContext.getInstance(),
    private persistence: IFrameworkPersistence &
      IApplicationPersistence &
      ITemplatePersistence,
    private applicationLoader?: ApplicationLoader,
  ) {
    if (!this.applicationLoader) {
      // ApplicationLoader expects StorageContext | undefined
      const storageContext =
        this.storage instanceof StorageContext ? this.storage : undefined;
      this.applicationLoader = new ApplicationLoader(
        this.pathes,
        this.persistence,
        storageContext,
      );
    }
  }

  public readFrameworkJson(
    framework: string,
    opts: IReadFrameworkOptions,
  ): IFramework {
    return this.persistence.readFramework(framework, opts);
  }

  public async getParameters(
    framework: string,
    task: TaskType,
    veContext: IVEContext,
  ): Promise<IParameter[]> {
    const opts: IReadFrameworkOptions = {
      error: new VEConfigurationError("", framework),
    };
    const frameworkData = this.readFrameworkJson(framework, opts);

    const appOpts: IReadApplicationOptions = {
      applicationHierarchy: [],
      error: new VEConfigurationError("", frameworkData.extends),
      taskTemplates: [],
    };
    // Validate and load base application (errors are collected in appOpts)
    try {
      this.applicationLoader!.readApplicationJson(
        frameworkData.extends,
        appOpts,
      );
    } catch (e: Error | any) {
      this.addErrorToOptions(opts, e);
    }

    // TemplateProcessor expects ContextManager, not StorageContext
    const contextManager =
      this.storage instanceof ContextManager
        ? this.storage
        : (this.storage as any).contextManager ||
          PersistenceManager.getInstance().getContextManager();
    const templateProcessor = new TemplateProcessor(
      this.pathes,
      contextManager,
      this.persistence,
    );
    const loaded = await templateProcessor.getParameters(
      frameworkData.extends,
      task,
      veContext,
    );

    const propertyIds = (frameworkData.properties || []).map((p) =>
      typeof p === "string" ? p : p.id,
    );
    const isDockerCompose =
      framework === "docker-compose" ||
      frameworkData.extends === "docker-compose";
    const isOciImage =
      framework === "oci-image" || frameworkData.extends === "oci-image";
    const result: IParameter[] = [];
    for (const propId of propertyIds) {
      const match = loaded.find((p) => p.id === propId);
      if (match) {
        // Clone parameter and apply framework-specific rules:
        // - remove 'advanced'
        // - set required based on framework-specific rules
        const cloned: IParameter = { ...match };
        delete (cloned as any).advanced;

        // Special handling for docker-compose and oci-image frameworks:
        // - hostname should be optional (Application ID can be used as default in frontend)
        // - compose_project should be optional
        if (isDockerCompose || isOciImage) {
          if (propId === "hostname") {
            cloned.required = false; // Optional - Application ID can be used as default
          } else if (propId === "compose_project") {
            cloned.required = false; // Force optional for docker-compose
          } else {
            // For other parameters, keep original required value (default to false if not defined)
            cloned.required = match.required === true;
          }
        } else {
          // For other frameworks, respect template-defined required value
          // Only mark as required if explicitly set to true in template
          cloned.required = match.required === true;
        }

        result.push(cloned);
      }
    }
    return result;
  }

  public async createApplicationFromFramework(
    request: IPostFrameworkCreateApplicationBody,
  ): Promise<string> {
    // Load framework
    const frameworkOpts: IReadFrameworkOptions = {
      error: new VEConfigurationError("", request.frameworkId),
    };
    const framework = this.readFrameworkJson(
      request.frameworkId,
      frameworkOpts,
    );

    // Load base application to get template list
    const appOpts: IReadApplicationOptions = {
      applicationHierarchy: [],
      error: new VEConfigurationError("", framework.extends),
      taskTemplates: [],
    };
    const baseApplication = this.applicationLoader!.readApplicationJson(
      framework.extends,
      appOpts,
    );

    // Get all parameters from base application to find parameter definitions
    // No veContext needed - we only need parameter definitions, not execution
    // TemplateProcessor expects ContextManager, not StorageContext
    const contextManager =
      this.storage instanceof ContextManager
        ? this.storage
        : (this.storage as any).contextManager ||
          PersistenceManager.getInstance().getContextManager();
    const templateProcessor = new TemplateProcessor(
      this.pathes,
      contextManager,
      this.persistence,
    );
    const allParameters = await templateProcessor.getParameters(
      framework.extends,
      "installation",
    );

    // Check if application already exists in local directory only
    // Allow creating local applications even if the same ID exists in json directory
    const localAppNames = this.persistence.getLocalAppNames();
    if (localAppNames.has(request.applicationId)) {
      if (request.update) {
        // In update mode, delete existing application directory first
        const existingAppPath = localAppNames.get(request.applicationId)!;
        fs.rmSync(existingAppPath, { recursive: true, force: true });
      } else {
        const existingAppPath = localAppNames.get(request.applicationId)!;
        throw new Error(
          `Application ${request.applicationId} already exists at ${existingAppPath}`,
        );
      }
    }

    // Application directory will be created by writeApplication
    const appDir = path.join(
      this.pathes.localPath,
      "applications",
      request.applicationId,
    );

    // Build parameterValues map for quick lookup
    const paramValuesMap = new Map<string, string | number | boolean>();
    for (const pv of request.parameterValues) {
      paramValuesMap.set(pv.id, pv.value);
    }

    // Separate properties into parameters (default: true) and outputs (others)
    const templateParameters: IParameter[] = [];
    const templateProperties: Array<{
      id: string;
      value: string | number | boolean;
    }> = [];

    for (const prop of framework.properties) {
      const propId = typeof prop === "string" ? prop : prop.id;
      const isDefault = typeof prop === "object" && prop.default === true;

      // Find parameter definition from base application
      const paramDef = allParameters.find((p) => p.id === propId);
      const paramValue = paramValuesMap.get(propId);

      // Special handling for docker-compose framework: ensure hostname is always added as parameter
      // even if it's not marked as default, so it can be used with Application ID as default
      const shouldAddAsParameter =
        isDefault ||
        (framework.id === "docker-compose" &&
          propId === "hostname" &&
          paramDef);

      if (shouldAddAsParameter && paramDef) {
        // Create parameter entry
        const param: IParameter = {
          ...paramDef,
        };
        if (
          paramValue !== undefined &&
          String(paramValue) !== String(paramDef.default)
        ) {
          // Only store user value if it differs from template default.
          // This ensures template default changes propagate to existing apps.
          param.default = paramValue;
        } else if (paramDef.default !== undefined) {
          param.default = paramDef.default;
        }

        // Special handling for hostname: use Application ID as default if not provided
        // This applies to both docker-compose and oci-image frameworks
        if (propId === "hostname") {
          if (
            framework.id === "docker-compose" ||
            framework.id === "oci-image"
          ) {
            param.required = false; // Optional - Application ID can be used as default
            // If hostname is not provided, use Application ID as default
            if (paramValue === undefined && paramDef.default === undefined) {
              param.default = request.applicationId;
            }
          }
        }

        // Special handling for docker-compose framework:
        // - compose_project should always be optional
        if (framework.id === "docker-compose") {
          if (propId === "compose_project") {
            param.required = false;
          }
        }

        templateParameters.push(param);
      } else if (paramValue !== undefined) {
        // For docker-compose framework: skip certain properties
        if (framework.id === "docker-compose") {
          // volumes is output by 310-extract-volumes-from-compose.json template
          if (propId === "volumes") {
            continue;
          }
          // env_file is handled separately below (marker detection)
        }

        // Create property/output entry
        templateProperties.push({
          id: propId,
          value: paramValue,
        });
      }
    }

    // Persist remaining parameterValues that match template parameters
    // but aren't listed in framework.properties (e.g., memory, disk_size from Step 5).
    // Only store values that differ from template defaults, so template updates propagate.
    const processedIds = new Set([
      ...templateParameters.map((p) => p.id),
      ...templateProperties.map((p) => p.id),
    ]);
    for (const [paramId, paramValue] of paramValuesMap) {
      if (processedIds.has(paramId)) continue;
      const paramDef = allParameters.find((p) => p.id === paramId);
      if (paramDef && String(paramValue) !== String(paramDef.default)) {
        templateParameters.push({ ...paramDef, default: paramValue });
      }
    }

    // For docker-compose framework ONLY: store compose_file in application.json
    // compose_file is base64-encoded and used as default at deployment (user doesn't need to re-upload)
    // Note: For oci-image framework, compose_file is NOT stored (not needed)
    if (framework.id === "docker-compose") {
      const composeFileValue = paramValuesMap.get("compose_file");

      if (composeFileValue && typeof composeFileValue === "string") {
        const composeFileIndex = templateProperties.findIndex(
          (p) => p.id === "compose_file",
        );
        if (composeFileIndex >= 0 && templateProperties[composeFileIndex]) {
          templateProperties[composeFileIndex].value = composeFileValue;
        } else {
          templateProperties.push({
            id: "compose_file",
            value: composeFileValue,
          });
        }

        // Also ensure it's in parameters if not already there
        const composeParamIndex = templateParameters.findIndex(
          (p) => p.id === "compose_file",
        );
        if (composeParamIndex < 0) {
          const composeParamDef = allParameters.find(
            (p) => p.id === "compose_file",
          );
          if (composeParamDef) {
            templateParameters.push({
              ...composeParamDef,
              default: composeFileValue,
            });
          }
        }
      }
    }

    // For docker-compose and oci-image frameworks: store env_file template and detect markers
    // If env_file contains {{ }} markers, user must upload a new .env at deployment time
    // If no markers, the stored template can be used directly
    if (framework.id === "docker-compose" || framework.id === "oci-image") {
      const envFileValue = paramValuesMap.get("env_file");
      if (envFileValue && typeof envFileValue === "string") {
        // Decode base64 and check for {{ }} markers
        const envContent = Buffer.from(envFileValue, "base64").toString("utf8");
        const hasMarkers = /\{\{.*?\}\}/.test(envContent);

        // Store marker flag as property (for dynamic required check at deployment)
        if (hasMarkers) {
          templateProperties.push({
            id: "env_file_has_markers",
            value: "true",
          });
        }

        // Store env_file template
        templateProperties.push({ id: "env_file", value: envFileValue });
      }
    }

    // For docker-compose and oci-image frameworks: ensure hostname is set as property if not provided
    // Use Application ID as default so it can be passed to templates
    if (framework.id === "docker-compose" || framework.id === "oci-image") {
      const hostnameValue = paramValuesMap.get("hostname");
      if (hostnameValue === undefined) {
        // hostname not provided, use Application ID as default
        const hostnamePropIndex = templateProperties.findIndex(
          (p) => p.id === "hostname",
        );
        if (hostnamePropIndex < 0) {
          templateProperties.push({
            id: "hostname",
            value: request.applicationId,
          });
        }
      }
    }

    // Create application.json with parameters and properties directly embedded (new 1-file format)
    // Note: Templates from the extended application (framework.extends) are automatically
    // loaded through the 'extends' mechanism. We should NOT add them to the installation
    // list again, as this would cause duplicates.
    const applicationJson: any = {
      name: request.name,
      description: request.description,
      extends: framework.extends,
      icon: request.icon || baseApplication.icon || "icon.png",
      // Parameters defined directly in application.json (new approach - no separate template needed)
      ...(templateParameters.length > 0 && { parameters: templateParameters }),
      // Properties defined directly in application.json (new approach - no separate template needed)
      ...(templateProperties.length > 0 && { properties: templateProperties }),
      // Empty installation - all templates come from extended application
      installation: {},
    };

    // Optional OCI / metadata fields: prefer request overrides, then framework, then base application
    const url =
      request.url ?? (framework as any).url ?? (baseApplication as any).url;
    const documentation =
      request.documentation ??
      (framework as any).documentation ??
      (baseApplication as any).documentation;
    const source =
      request.source ??
      (framework as any).source ??
      (baseApplication as any).source;
    const vendor =
      request.vendor ??
      (framework as any).vendor ??
      (baseApplication as any).vendor;

    if (url) {
      applicationJson.url = url;
    }
    if (documentation) {
      applicationJson.documentation = documentation;
    }
    if (source) {
      applicationJson.source = source;
    }
    if (vendor) {
      applicationJson.vendor = vendor;
    }
    if (request.tags && request.tags.length > 0) {
      applicationJson.tags = request.tags;
    }
    if (request.stacktype) {
      applicationJson.stacktype = request.stacktype;
    }

    // Write application.json using persistence
    // Note: We pass applicationJson without 'id' - it will be added when reading
    // Type assertion needed because writeApplication expects IApplication, but we don't want to write 'id'
    this.persistence.writeApplication(
      request.applicationId,
      applicationJson as any,
    );

    // Write icon if provided
    if (request.iconContent) {
      const iconPath = path.join(appDir, request.icon || "icon.png");
      const iconBuffer = Buffer.from(request.iconContent, "base64");
      fs.writeFileSync(iconPath, iconBuffer);
    }

    // Process uploadfiles: create template and script for each uploaded file
    if (request.uploadfiles && request.uploadfiles.length > 0) {
      const uploadTemplateNames: string[] = [];

      for (let i = 0; i < request.uploadfiles.length; i++) {
        const uploadFile = request.uploadfiles[i]!;
        const fileLabel = this.getUploadFileLabel(uploadFile);
        const sanitized = this.sanitizeFilename(fileLabel);
        const templateName = `${i}-upload-${sanitized}`;
        const scriptName = `${i}-upload-${sanitized}.sh`;
        const contentParamId = `upload_${sanitized.replace(/-/g, "_")}_content`;
        const destParamId = `upload_${sanitized.replace(/-/g, "_")}_destination`;
        const outputId = `upload_${sanitized.replace(/-/g, "_")}_uploaded`;

        // Merge content from parameterValues if not already on uploadFile
        const fileContent =
          uploadFile.content ??
          (paramValuesMap.get(contentParamId) as string | undefined);

        // Generate the template
        const uploadTemplate = {
          name: `Upload ${fileLabel}`,
          description: `Uploads ${fileLabel} to ${uploadFile.destination}`,
          execute_on: "ve",
          skip_if_all_missing: [contentParamId],
          parameters: [
            {
              id: contentParamId,
              name: fileLabel,
              type: "string",
              upload: true,
              required: uploadFile.required ?? false,
              advanced: uploadFile.advanced ?? false,
              description: `Configuration file: ${fileLabel}`,
              ...(fileContent ? { default: fileContent } : {}),
            },
            {
              id: destParamId,
              name: "Destination Path",
              type: "string",
              default: uploadFile.destination,
              advanced: true,
              description: "Target path: {volume_key}:{filename}",
            },
            {
              id: "shared_volpath",
              name: "Shared Volume Path",
              type: "string",
              advanced: true,
              description: "Path to the shared volume mount point",
            },
            {
              id: "hostname",
              name: "Hostname",
              type: "string",
              required: true,
              description: "Container hostname",
            },
            {
              id: "uid",
              name: "UID",
              type: "string",
              default: "0",
              advanced: true,
              description: "User ID for file ownership",
            },
            {
              id: "gid",
              name: "GID",
              type: "string",
              default: "0",
              advanced: true,
              description: "Group ID for file ownership",
            },
            {
              id: "mapped_uid",
              name: "Mapped UID",
              type: "string",
              default: "",
              advanced: true,
              description: "Mapped user ID for unprivileged containers",
            },
            {
              id: "mapped_gid",
              name: "Mapped GID",
              type: "string",
              default: "",
              advanced: true,
              description: "Mapped group ID for unprivileged containers",
            },
          ],
          commands: [
            {
              name: `Upload ${fileLabel}`,
              script: scriptName,
              library: "upload-file-common.sh",
              outputs: [outputId],
            },
          ],
        };

        // Write the template
        this.persistence.writeTemplate(templateName, uploadTemplate as any, false, appDir);

        // Generate the script
        const scriptContent = `#!/bin/sh
# Upload file: ${fileLabel}
# Auto-generated by create-application
set -eu

upload_pre_start_file \\
  "{{ ${contentParamId} }}" \\
  "{{ ${destParamId} }}" \\
  "${fileLabel}" \\
  "{{ shared_volpath }}" \\
  "{{ hostname }}" \\
  "{{ uid }}" \\
  "{{ gid }}" \\
  "{{ mapped_uid }}" \\
  "{{ mapped_gid }}"

upload_output_result "${outputId}"
`;
        this.persistence.writeScript(scriptName, scriptContent, false, appDir);

        uploadTemplateNames.push(`${templateName}.json`);
      }

      // Update application.json with pre_start templates
      if (uploadTemplateNames.length > 0) {
        const appJsonPath = path.join(appDir, "application.json");
        const appJson = JSON.parse(fs.readFileSync(appJsonPath, "utf8"));

        // Ensure installation.pre_start exists
        if (!appJson.installation) {
          appJson.installation = {};
        }
        if (!appJson.installation.pre_start) {
          appJson.installation.pre_start = [];
        }

        // Add upload templates at the end of pre_start
        for (const templateName of uploadTemplateNames) {
          appJson.installation.pre_start.push(templateName);
        }

        fs.writeFileSync(appJsonPath, JSON.stringify(appJson, null, 2));
      }
    }

    return request.applicationId;
  }

  /**
   * Prepare application parameters from framework request data.
   * Shared logic between createApplicationFromFramework and getPreviewUnresolvedParameters.
   */
  private async prepareApplicationParameters(
    request: IFrameworkApplicationDataBody,
  ): Promise<{
    framework: IFramework;
    initialInputs: Array<{ id: string; value: IParameterValue }>;
  }> {
    // Load framework
    const frameworkOpts: IReadFrameworkOptions = {
      error: new VEConfigurationError("", request.frameworkId),
    };
    const framework = this.readFrameworkJson(request.frameworkId, frameworkOpts);

    // Build initialInputs from parameterValues
    const initialInputs: Array<{ id: string; value: IParameterValue }> = [];
    for (const pv of request.parameterValues) {
      if (pv.value !== null && pv.value !== undefined && pv.value !== "") {
        initialInputs.push({ id: pv.id, value: pv.value });
      }
    }

    // Add upload file contents as parameters (same logic as in createApplicationFromFramework)
    if (request.uploadfiles && request.uploadfiles.length > 0) {
      for (const uploadFile of request.uploadfiles) {
        if (uploadFile.content) {
          const fileLabel = this.getUploadFileLabel(uploadFile);
          const sanitized = this.sanitizeFilename(fileLabel);
          const contentParamId = `upload_${sanitized.replace(/-/g, "_")}_content`;
          initialInputs.push({ id: contentParamId, value: uploadFile.content });
        }
      }
    }

    return { framework, initialInputs };
  }

  /**
   * Get a preview of the unresolved parameters that will be shown during installation.
   * Uses the same parameter resolution logic as the actual installation flow.
   *
   * IMPORTANT: parameterValues from step 3 (framework parameters like 'volumes') are
   * treated as defaults, NOT as resolved inputs. This matches how createApplicationFromFramework
   * writes them to application.json (as param.default), so the preview shows the same
   * parameters that will be editable after the application is created.
   */
  public async getPreviewUnresolvedParameters(
    request: IFrameworkApplicationDataBody,
    task: TaskType,
    veContext: IVEContext,
  ): Promise<IParameter[]> {
    const { framework } = await this.prepareApplicationParameters(request);

    // Build a map of parameterValues for later use as defaults
    const paramValuesMap = new Map<string, IParameterValue>();
    for (const pv of request.parameterValues) {
      if (pv.value !== null && pv.value !== undefined && pv.value !== "") {
        paramValuesMap.set(pv.id, pv.value);
      }
    }

    // Only pass upload file contents as initialInputs (not framework parameters)
    // Framework parameters (like 'volumes') will be applied as defaults below,
    // matching how createApplicationFromFramework writes them to application.json
    const initialInputs: Array<{ id: string; value: IParameterValue }> = [];
    if (request.uploadfiles && request.uploadfiles.length > 0) {
      for (const uploadFile of request.uploadfiles) {
        if (uploadFile.content) {
          const fileLabel = this.getUploadFileLabel(uploadFile);
          const sanitized = this.sanitizeFilename(fileLabel);
          const contentParamId = `upload_${sanitized.replace(/-/g, "_")}_content`;
          initialInputs.push({ id: contentParamId, value: uploadFile.content });
        }
      }
    }

    // TemplateProcessor expects ContextManager, not StorageContext
    const contextManager =
      this.storage instanceof ContextManager
        ? this.storage
        : (this.storage as any).contextManager ||
          PersistenceManager.getInstance().getContextManager();

    const templateProcessor = new TemplateProcessor(
      this.pathes,
      contextManager,
      this.persistence,
    );

    // Load application with only upload inputs (not framework parameters)
    const loaded = await templateProcessor.loadApplication(
      framework.extends,
      task,
      veContext,
      undefined,
      initialInputs,
      true, // skipUnresolved / enumValuesRefresh
    );

    // Apply parameterValues as defaults to loaded parameters
    // This matches how createApplicationFromFramework writes them (param.default = value)
    for (const param of loaded.parameters) {
      const value = paramValuesMap.get(param.id);
      if (value !== undefined) {
        param.default = value;
      }
    }

    // Use same filtering logic as TemplateProcessor.getUnresolvedParameters()
    let unresolvedParams: IParameter[];

    if (loaded.parameterTrace && loaded.parameterTrace.length > 0) {
      const traceById = new Map(
        loaded.parameterTrace.map((entry) => [entry.id, entry]),
      );
      unresolvedParams = loaded.parameters.filter((param) => {
        if (param.type === "enum") return true;
        const trace = traceById.get(param.id);
        // Include parameters that are missing OR have only a default value
        // (both should be shown as editable in the UI)
        return trace
          ? trace.source === "missing" || trace.source === "default"
          : true;
      });
    } else {
      // Fallback: Only parameters whose id is not in resolvedParams
      unresolvedParams = loaded.parameters.filter(
        (param) =>
          undefined ==
          loaded.resolvedParams.find(
            (rp) => rp.id == param.id && rp.template != param.template,
          ),
      );
    }

    // Add virtual upload parameters if uploadfiles are defined
    if (request.uploadfiles && request.uploadfiles.length > 0) {
      const uploadParams = this.generateUploadParameters(request.uploadfiles);

      for (const uploadParam of uploadParams) {
        const existingParam = unresolvedParams.find(
          (p) => p.id === uploadParam.id,
        );
        if (!existingParam) {
          unresolvedParams.push(uploadParam);
        }
      }
    }

    return unresolvedParams;
  }

  /**
   * Generate virtual upload parameters from uploadfiles definition.
   * Used by getPreviewUnresolvedParameters to show upload parameters
   * before the actual templates are created on the filesystem.
   */
  private generateUploadParameters(uploadfiles: IUploadFile[]): IParameter[] {
    const parameters: IParameter[] = [];

    for (const uploadFile of uploadfiles) {
      const fileLabel = this.getUploadFileLabel(uploadFile);
      const sanitized = this.sanitizeFilename(fileLabel);
      const contentParamId = `upload_${sanitized.replace(/-/g, "_")}_content`;

      parameters.push({
        id: contentParamId,
        name: fileLabel,
        type: "string",
        upload: true,
        required: uploadFile.required ?? false,
        advanced: uploadFile.advanced ?? false,
        description: `Configuration file: ${fileLabel}`,
        templatename: "Upload Files",
        ...(uploadFile.content ? { default: uploadFile.content } : {}),
      });
    }

    return parameters;
  }

  /**
   * Sanitize filename for use in parameter IDs and template names
   */
  private sanitizeFilename(filename: string): string {
    const base = path.basename(filename, path.extname(filename));
    return base.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
  }

  /**
   * Get the display label for an upload file.
   * Returns the explicit label if set, otherwise extracts the filename from destination.
   * @example getUploadFileLabel({ destination: "config:certs/server.crt" }) => "server.crt"
   * @example getUploadFileLabel({ destination: "config:app.conf", label: "App Config" }) => "App Config"
   */
  private getUploadFileLabel(uploadFile: IUploadFile): string {
    if (uploadFile.label) {
      return uploadFile.label;
    }
    // Handle missing destination (shouldn't happen but be defensive)
    if (!uploadFile.destination) {
      return 'unknown';
    }
    // Extract filename from destination (format: "volume:path/to/file.ext")
    const colonIndex = uploadFile.destination.indexOf(':');
    const filePath = colonIndex >= 0 ? uploadFile.destination.slice(colonIndex + 1) : uploadFile.destination;
    return path.basename(filePath);
  }

  private addErrorToOptions(opts: IReadFrameworkOptions, error: Error | any) {
    if (opts.error && Array.isArray(opts.error.details)) {
      opts.error.details.push(error);
    } else if (opts.error) {
      opts.error.details = [error];
    } else {
      throw new JsonError(error?.message || String(error));
    }
  }
}
