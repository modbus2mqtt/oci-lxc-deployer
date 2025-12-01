import { JsonError } from "./jsonvalidator.mjs";
import { IJsonError, TaskType } from "./types.mjs";

export class ProxmoxConfigurationError extends JsonError {
  constructor(message: string, application: string, details?: IJsonError[]) {
    super(message, details, application);
    this.name = "ProxmoxConfigurationError";
    this.filename = application;
  }
}
export interface IResolvedParam {
  template: string;
  param: string;
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
