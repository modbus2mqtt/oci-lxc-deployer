import path from "path";
import fs from "fs";
import { ApplicationLoader } from "./apploader.mjs";
import {
  IConfiguredPathes,
  VEConfigurationError,
  IReadApplicationOptions,
} from "./backend-types.mjs";
import { IFramework } from "./types.mjs";
import { StorageContext } from "./storagecontext.mjs";
import { ContextManager } from "./context-manager.mjs";
import { JsonError } from "./jsonvalidator.mjs";
import { TemplateProcessor } from "./templates/templateprocessor.mjs";
import { TaskType, IParameter, IPostFrameworkCreateApplicationBody } from "./types.mjs";
import { IVEContext } from "./backend-types.mjs";
import { IFrameworkPersistence, IApplicationPersistence, ITemplatePersistence } from "./persistence/interfaces.mjs";
import { PersistenceManager } from "./persistence/persistence-manager.mjs";

export interface IReadFrameworkOptions {
  framework?: IFramework;
  frameworkPath?: string;
  error: VEConfigurationError;
}

export class FrameworkLoader {
  constructor(
    private pathes: IConfiguredPathes,
    private storage: StorageContext | ContextManager = StorageContext.getInstance(),
    private persistence: IFrameworkPersistence & IApplicationPersistence & ITemplatePersistence,
    private applicationLoader?: ApplicationLoader,
  ) {
    if (!this.applicationLoader) {
      // ApplicationLoader expects StorageContext | undefined
      const storageContext = this.storage instanceof StorageContext ? this.storage : undefined;
      this.applicationLoader = new ApplicationLoader(this.pathes, this.persistence, storageContext);
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
    const contextManager = this.storage instanceof ContextManager 
      ? this.storage 
      : (this.storage as any).contextManager || PersistenceManager.getInstance().getContextManager();
    const templateProcessor = new TemplateProcessor(this.pathes, contextManager, this.persistence);
    const loaded = await templateProcessor.getParameters(
      frameworkData.extends,
      task,
      veContext,
    );

    const propertyIds = (frameworkData.properties || []).map((p) =>
      typeof p === "string" ? p : p.id,
    );
    const isDockerCompose = framework === 'docker-compose' || frameworkData.extends === 'docker-compose';
    const result: IParameter[] = [];
    for (const propId of propertyIds) {
      const match = loaded.find((p) => p.id === propId);
      if (match) {
        // Clone parameter and apply framework-specific rules:
        // - remove 'advanced'
        // - set required based on framework-specific rules
        const cloned: IParameter = { ...match };
        delete (cloned as any).advanced;
        
        // Special handling for docker-compose framework:
        // - hostname should be optional (Application ID can be used as default)
        // - compose_project should be optional
        if (isDockerCompose) {
          if (propId === 'hostname') {
            cloned.required = false; // Optional - Application ID can be used as default
          } else if (propId === 'compose_project') {
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
    const framework = this.readFrameworkJson(request.frameworkId, frameworkOpts);

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
    const contextManager = this.storage instanceof ContextManager 
      ? this.storage 
      : (this.storage as any).contextManager || PersistenceManager.getInstance().getContextManager();
    const templateProcessor = new TemplateProcessor(this.pathes, contextManager, this.persistence);
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
    const templateProperties: Array<{ id: string; value: string | number | boolean }> = [];

    for (const prop of framework.properties) {
      const propId = typeof prop === "string" ? prop : prop.id;
      const isDefault = typeof prop === "object" && prop.default === true;

      // Find parameter definition from base application
      const paramDef = allParameters.find((p) => p.id === propId);
      const paramValue = paramValuesMap.get(propId);

      // Special handling for docker-compose framework: ensure hostname is always added as parameter
      // even if it's not marked as default, so it can be used with Application ID as default
      const shouldAddAsParameter = isDefault || (framework.id === 'docker-compose' && propId === 'hostname' && paramDef);

      if (shouldAddAsParameter && paramDef) {
        // Create parameter entry
        const param: IParameter = {
          ...paramDef,
        };
        if (paramValue !== undefined) {
          param.default = paramValue;
        } else if (paramDef.default !== undefined) {
          param.default = paramDef.default;
        }
        
        // Special handling for docker-compose framework:
        // - hostname should be optional (Application ID can be used as default)
        // - compose_project should always be optional
        if (framework.id === 'docker-compose') {
          if (propId === 'hostname') {
            param.required = false; // Optional - Application ID can be used as default
            // If hostname is not provided, use Application ID as default
            if (paramValue === undefined && paramDef.default === undefined) {
              param.default = request.applicationId;
            }
          } else if (propId === 'compose_project') {
            param.required = false;
          }
        }
        
        templateParameters.push(param);
      } else if (paramValue !== undefined) {
        // For docker-compose framework: skip certain properties
        if (framework.id === 'docker-compose') {
          // volumes is output by 310-extract-volumes-from-compose.json template
          if (propId === 'volumes') {
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

    // For docker-compose framework ONLY: store compose_file in application.json
    // compose_file is base64-encoded and used as default at deployment (user doesn't need to re-upload)
    // Note: For oci-image framework, compose_file is NOT stored (not needed)
    if (framework.id === 'docker-compose') {
      const composeFileValue = paramValuesMap.get('compose_file');

      if (composeFileValue && typeof composeFileValue === 'string') {
        const composeFileIndex = templateProperties.findIndex(p => p.id === 'compose_file');
        if (composeFileIndex >= 0 && templateProperties[composeFileIndex]) {
          templateProperties[composeFileIndex].value = composeFileValue;
        } else {
          templateProperties.push({ id: 'compose_file', value: composeFileValue });
        }

        // Also ensure it's in parameters if not already there
        const composeParamIndex = templateParameters.findIndex(p => p.id === 'compose_file');
        if (composeParamIndex < 0) {
          const composeParamDef = allParameters.find((p) => p.id === 'compose_file');
          if (composeParamDef) {
            templateParameters.push({
              ...composeParamDef,
              default: composeFileValue,
            });
          }
        }
      }
    }
    
    // For docker-compose framework: store env_file template and detect markers
    // If env_file contains {{ }} markers, user must upload a new .env at deployment time
    // If no markers, the stored template can be used directly
    if (framework.id === 'docker-compose') {
      const envFileValue = paramValuesMap.get('env_file');
      if (envFileValue && typeof envFileValue === 'string') {
        // Decode base64 and check for {{ }} markers
        const envContent = Buffer.from(envFileValue, 'base64').toString('utf8');
        const hasMarkers = /\{\{.*?\}\}/.test(envContent);

        // Store marker flag as property (for dynamic required check at deployment)
        if (hasMarkers) {
          templateProperties.push({ id: 'env_file_has_markers', value: 'true' });
        }

        // Store env_file template
        templateProperties.push({ id: 'env_file', value: envFileValue });
      }
    }

    // For docker-compose framework: ensure hostname is set as property if not provided
    // Use Application ID as default so it can be passed to templates
    if (framework.id === 'docker-compose') {
      const hostnameValue = paramValuesMap.get('hostname');
      if (hostnameValue === undefined) {
        // hostname not provided, use Application ID as default
        const hostnamePropIndex = templateProperties.findIndex(p => p.id === 'hostname');
        if (hostnamePropIndex < 0) {
          templateProperties.push({ id: 'hostname', value: request.applicationId });
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
      // Empty installation list - all templates come from extended application
      installation: [],
    };

    // Optional OCI / metadata fields: prefer request overrides, then framework, then base application
    const url = request.url ?? (framework as any).url ?? (baseApplication as any).url;
    const documentation =
      request.documentation ?? (framework as any).documentation ?? (baseApplication as any).documentation;
    const source = request.source ?? (framework as any).source ?? (baseApplication as any).source;
    const vendor = request.vendor ?? (framework as any).vendor ?? (baseApplication as any).vendor;

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

    // Write application.json using persistence
    // Note: We pass applicationJson without 'id' - it will be added when reading
    // Type assertion needed because writeApplication expects IApplication, but we don't want to write 'id'
    this.persistence.writeApplication(request.applicationId, applicationJson as any);

    // Write icon if provided
    if (request.iconContent) {
      const iconPath = path.join(appDir, request.icon || "icon.png");
      const iconBuffer = Buffer.from(request.iconContent, "base64");
      fs.writeFileSync(iconPath, iconBuffer);
    }

    return request.applicationId;
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

