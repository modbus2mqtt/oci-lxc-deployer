export interface IJsonError extends Error {
  line?: number;
  message: string;
  details: IJsonError[] | undefined;
}
export interface ISsh {
  host: string;
  port: number;
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
  | "upgrade";
// Generated from template.schema.json
export interface ICommand {
  name: string;
  command?: string;
  script?: string;
  template?: string;
  description?: string;
  execute_on?: "proxmox" | "lxc";
}

export interface IProxmoxExecuteMessage {
  command: string;
  commandtext?: string;
  //commandtext: string;
  stderr: string;
  result: string | null;
  exitCode: number;
  execute_on?: "proxmox" | "lxc";
  error?: IJsonError;
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
  template?: string;
}

export interface ITemplate {
  execute_on: "proxmox" | "lxc";
  if?: boolean;
  name: string;
  description?: string;
  parameters?: IParameter[];
  outputs?: string[];
  commands: ICommand[];
}
export interface IError {
  message: string;
  errors?: string[];
}
