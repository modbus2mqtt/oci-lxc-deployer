import { JsonError } from "./jsonvalidator.mjs";
import { ICommand, IJsonError, IParameter, TaskType } from "./types.mjs";

export class ProxmoxConfigurationError extends JsonError {
  constructor(message: string, application: string, details?: IJsonError[]) {
    super(message, details, application);
    this.name = "ProxmoxConfigurationError";
    this.filename = application;
  }
}
export interface IResolvedParam {
  id: string; 
  template: string
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
  outputs?: { id: string; default?: string | number | boolean , value?: string | number | boolean }[];
  commands: ICommand[];
}