import { JsonError } from "./jsonvalidator.mjs";
import { StorageContext } from "./storagecontext.mjs";
import { ICommand, IJsonError, IParameter, ISsh, TaskType } from "./types.mjs";

export class VEConfigurationError extends JsonError {
  constructor(message: string, application: string, details?: IJsonError[]) {
    super(message, details, application);
    this.name = "VEConfigurationError";
    this.filename = application;
  }
}
export interface IResolvedParam {
  id: string;
  template: string;
}
export interface IApplicationBase {
  name: string;
  extends?: string;
  description?: string;
  icon?: string;
}

export interface IConfiguredPathes {
  schemaPath: string;
  jsonPath: string;
  localPath: string;
}
export interface ITemplate {
  execute_on: "proxmox" | "lxc";
  if?: boolean;
  name: string;
  description?: string;
  parameters?: IParameter[];
  outputs?: {
    id: string;
    default?: string | number | boolean;
    value?: string | number | boolean;
  }[];
  commands: ICommand[];
}
export const storageKey = "global_storage_context";
export interface IContext {
  getKey(): string;
}
export interface IVMContext {
  vmid: number;
  vekey: string;
}
export interface IApplicationBase {
  name: string;
  extends?: string;
  description?: string;
  icon?: string;
}
// Interface generated from application.schema.json
export type IApplicationSchema = IApplicationBase & {
  [key in TaskType]?: string[];
};

export interface IApplication extends IApplicationSchema {
  id: string;
}
export interface IReadApplicationOptions {
  applicationHierarchy: string[];
  application?: IApplication;
  appPath?: string;
  error: VEConfigurationError;
  taskTemplates: {
    task: string;
    templates: string[];
  }[];
}

export class VELoadApplicationError extends VEConfigurationError {
  constructor(
    message: string,
    application: string,
    private task?: string,
    details?: IJsonError[],
  ) {
    super(message, application, details);
    this.name = "VELoadApplicationError";
    this.filename = application;
  }
}
// Interface generated from template.schema.json
export interface ITemplateSchema {}

export interface IVEContext extends ISsh {
  getStorageContext(): StorageContext;
}
