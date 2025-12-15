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
export interface ICommand {
  name: string;
  command?: string;
  script?: string;
  template?: string;
  description?: string;
  execute_on?: string;
}

export interface IProxmoxExecuteMessage {
  command: string;
  commandtext?: string;
  //commandtext: string;
  stderr: string;
  result: string | null;
  exitCode: number;
  execute_on?: string;
  error?: IJsonError|undefined;
  index?: number;
}

export type ParameterType = "string" | "number" | "boolean" | "enum";

export interface IParameter {
  id: string;
  name: string;
  type: ParameterType;
  description?: string;
  required?: boolean;
  secure?: boolean;
  default?: string | number | boolean;
  enumValues?: string[];
  templatename?: string;
  template?: string;
  if?: string;
}

export interface ITemplate {
  execute_on: "ve" | "lxc";
  if?: boolean;
  name: string;
  description?: string;
  parameters?: IParameter[];
  outputs?: { id: string; default?: boolean }[];
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
  VeExecute = "/api/ve/execute",
  Applications = "/api/applications",
  UnresolvedParameters = "/api/getUnresolvedParameters/:application/:task"

}
