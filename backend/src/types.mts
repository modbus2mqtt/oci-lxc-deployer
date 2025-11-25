import { E } from "node_modules/vitest/dist/chunks/environment.d.CrsxCzP1.js";

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
  errors?: string[];
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
  type: "command" | "script" | "template";
  name: string;
  execute: string;
  description?: string;
  execute_on?: "proxmox" | "lxc";
}

export interface IProxmoxExecuteMessage {
  command: string;
  commandtext: string;
  stderr: string;
  result: string | null;
  exitCode: number;
  execute_on?: "proxmox" | "lxc";
  error?: Error;
  index?: number;
}
export interface IParameter {
  name: string;
  type: "string" | "number" | "boolean";
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
  parameters?: Array<IParameter>;
  outputs?: string[];
  commands: Array<ICommand>;
}
export interface IError {
  message: string;
  errors?: string[];
}
