export interface IJsonError extends Error {
  line?: number;
  message: string;
  details: IJsonError[] | undefined;
}
export interface ISsh {
  host: string;
  port?: number;
  current?: boolean;
  publicKeyCommand?: string;
  installSshServer?: string;
  permissionOk?: boolean;
}
export interface IApplicationBase {
  name: string;
  description: string;
  icon?: string | undefined;
  errors?: string[];
}
export interface IApplicationWeb {
  name: string;
  description: string;
  icon?: string | undefined;
  iconContent?: string | undefined;
  iconType?: string | undefined;
  id: string;
  errors?: IJsonError[];
}
export type TaskType =
  | "installation"
  | "backup"
  | "restore"
  | "uninstall"
  | "update"
  | "upgrade"
  | "webui";
// Generated from template.schema.json
export interface IOutputObject {
  id: string;
  value?: string | number | boolean | Array<string | { name: string; value: string | number | boolean } | { id: string; value: string | number | boolean }>;
}

export interface ICommand {
  name: string;
  command?: string;
  script?: string;
  library?: string;
  libraryPath?: string; // Internal: resolved full path to library file
  template?: string;
  properties?: IOutputObject | IOutputObject[];
  outputs?: Array<{ id: string; default?: boolean } | string>; // Expected outputs from this command/script
  description?: string;
  /** @internal execute_on is set internally from template.execute_on, not part of the schema */
  execute_on?: "ve" | "lxc" | string;
}

export interface IVeExecuteMessage {
  command: string;
  commandtext?: string;
  //commandtext: string;
  stderr: string;
  result: string | null;
  exitCode: number;
  execute_on?: string;
  error?: IJsonError | undefined;
  index?: number;
  finished?: boolean;
  partial?: boolean; // If true, this is a partial/streaming output chunk (process still running)
}

export type ParameterType = "string" | "number" | "boolean" | "enum";
export type IParameterValue = string | number | boolean;

export interface IParameter {
  id: string;
  name: string;
  type: ParameterType;
  description?: string;
  required?: boolean;
  secure?: boolean;
  advanced?: boolean;
  upload?: boolean;
  default?: string | number | boolean;
  enumValues?: (string | { name: string; value: string | number | boolean })[];
  templatename?: string;
  template?: string;
  if?: string;
}

export interface ITemplate {
  execute_on?: "ve" | "lxc" | string; // string allows "host:hostname" pattern. Optional if template only has properties commands
  skip_if_all_missing?: string[];
  skip_if_property_set?: string;
  name: string;
  description?: string;
  parameters?: IParameter[];
  commands: ICommand[];
}
export interface IError {
  message: string;
  errors?: string[];
}

export enum ApiUri {
  SshConfigs = "/api/sshconfigs",
  SshConfig = "/api/sshconfig",
  SshConfigGET = "/api/ssh/config/:host",
  SshCheck = "/api/ssh/check",
  VeConfiguration = "/api/ve-configuration/:application/:task/:veContext",
  VeRestart = "/api/ve/restart/:restartKey/:veContext",
  VeRestartInstallation = "/api/ve/restart-installation/:vmInstallKey/:veContext",
  VeExecute = "/api/ve/execute/:veContext",
  Applications = "/api/applications",
  TemplateDetailsForApplication = "/api/template-details/:application/:task/:veContext",
  UnresolvedParameters = "/api/unresolved-parameters/:application/:task/:veContext",
}

// Response interfaces for all backend endpoints (frontend mirror)
export interface IUnresolvedParametersResponse {
  unresolvedParameters: IParameter[];
}
export interface ISshConfigsResponse {
  sshs: ISsh[];
  key?: string | undefined;
}
export interface ISshConfigKeyResponse {
  key: string;
}
export interface ISshCheckResponse {
  permissionOk: boolean;
  stderr?: string | undefined;
}
export interface ISetSshConfigResponse {
  success: boolean;
  key?: string | undefined;
}
export interface IDeleteSshConfigResponse {
  success: boolean;
  deleted?: boolean;
  key?: string | undefined;
}
export interface IPostVeConfigurationBody {
  params: { name: string; value: IParameterValue }[];
  outputs?: { id: string; value: IParameterValue }[];
  changedParams?: { name: string; value: IParameterValue }[];
}
export interface IPostSshConfigResponse {
  success: boolean;
  key?: string;
}
export interface IPostVeConfigurationResponse {
  success: boolean;
  restartKey?: string;
  vmInstallKey?: string;
}
export type IApplicationsResponse = IApplicationWeb[];
export interface ISingleExecuteMessagesResponse {
  application: string;
  task: string;
  messages: IVeExecuteMessage[];
  restartKey?: string;
  vmInstallKey?: string;
}
export interface IApplicationResponse {
  application: IApplicationWeb;
  parameters: IParameter[];
}

export type IVeExecuteMessagesResponse = ISingleExecuteMessagesResponse[];
export interface IVeConfigurationResponse {
  success: boolean;
  restartKey?: string;
  vmInstallKey?: string;
}
