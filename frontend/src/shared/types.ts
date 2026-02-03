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
  extends?: string;
  tags?: string[];
  url?: string;
  documentation?: string;
  source?: string;
  vendor?: string;
  errors?: string[];
}
export interface IApplicationWeb {
  name: string;
  description: string;
  icon?: string | undefined;
  iconContent?: string | undefined;
  iconType?: string | undefined;
  id: string;
  tags?: string[] | undefined;
  source: "local" | "json";
  framework?: string | undefined;
  errors?: IJsonError[];
}
export type TaskType =
  | "installation"
  | "backup"
  | "restore"
  | "uninstall"
  | "update"
  | "upgrade"
  | "copy-upgrade"
  | "copy-rollback"
  | "webui";
// Generated from template.schema.json
export interface IOutputObject {
  id: string;
  value?: string | number | boolean | (string | { name: string; value: string | number | boolean } | { id: string; value: string | number | boolean })[];
}

export interface ICommand {
  name: string;
  command?: string;
  script?: string;
  library?: string;
  libraryPath?: string; // Internal: resolved full path to library file
  template?: string;
  properties?: IOutputObject | IOutputObject[];
  outputs?: ({ id: string; default?: boolean } | string)[]; // Expected outputs from this command/script
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
  multiline?: boolean;
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
  ApplicationTags = "/api/applications/tags",
  LocalApplicationIds = "/api/applications/local/ids",
  Installations = "/api/installations/:veContext",
  VeCopyUpgrade = "/api/ve/copy-upgrade/:application/:veContext",
  TemplateDetailsForApplication = "/api/template-details/:application/:task/:veContext",
  UnresolvedParameters = "/api/unresolved-parameters/:application/:task/:veContext",
  EnumValues = "/api/enum-values/:application/:task/:veContext",
  FrameworkNames = "/api/framework-names",
  FrameworkParameters = "/api/framework-parameters/:frameworkId",
  FrameworkCreateApplication = "/api/framework-create-application",
  FrameworkFromImage = "/api/framework-from-image",
  ApplicationFrameworkData = "/api/application/:applicationId/framework-data",
  CompatibleAddons = "/api/addons/compatible/:application",
  AddonInstall = "/api/addons/install/:addonId/:veContext",
}

export interface IPostAddonInstallBody {
  vm_id: number;
  application_id?: string;
  params?: { name: string; value: string | number | boolean }[];
}

// Tags definition interfaces
export interface ITagDefinition {
  id: string;
  name: string;
}

export interface ITagGroup {
  id: string;
  name: string;
  tags: ITagDefinition[];
}

export interface ITagsConfig {
  groups: ITagGroup[];
  internal: string[];
}

export type ITagsConfigResponse = ITagsConfig;

// Response interfaces for all backend endpoints (frontend mirror)
export interface IUnresolvedParametersResponse {
  unresolvedParameters: IParameter[];
}
export interface IEnumValuesEntry {
  id: string;
  enumValues: (string | { name: string; value: string | number | boolean })[];
  default?: string | number | boolean;
}
export interface IEnumValuesResponse {
  enumValues: IEnumValuesEntry[];
}

export interface ITemplateTraceEntry {
  name: string;
  path: string;
  origin:
    | "application-local"
    | "application-json"
    | "shared-local"
    | "shared-json"
    | "unknown";
  isShared: boolean;
  skipped: boolean;
  conditional: boolean;
}

export interface IParameterTraceEntry {
  id: string;
  name: string;
  required?: boolean;
  default?: string | number | boolean;
  template?: string;
  templatename?: string;
  source:
    | "user_input"
    | "template_output"
    | "template_properties"
    | "default"
    | "missing";
  sourceTemplate?: string;
  sourceKind?: "outputs" | "properties";
}

export interface ITemplateTraceInfo {
  application: string;
  task: TaskType;
  localDir: string;
  jsonDir: string;
  appLocalDir?: string;
  appJsonDir?: string;
}

export interface ITemplateProcessorLoadResult {
  templateTrace?: ITemplateTraceEntry[];
  parameterTrace?: IParameterTraceEntry[];
  traceInfo?: ITemplateTraceInfo;
}
export interface ISshConfigsResponse {
  sshs: ISsh[];
  key?: string | undefined;
  publicKeyCommand?: string | undefined;
  installSshServer?: string | undefined;
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
export interface IPostEnumValuesBody {
  params?: { id: string; value: IParameterValue }[];
  refresh?: boolean;
}
export interface IPostVeCopyUpgradeBody {
  oci_image: string;
  source_vm_id: number;
  vm_id?: number;
  disk_size?: string;
  bridge?: string;
  memory?: number;
  storage?: string;
  registry_username?: string;
  registry_password?: string;
  registry_token?: string;
  platform?: string;
  application_id?: string;
  application_name?: string;
  version?: string;
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

export interface IManagedOciContainer {
  vm_id: number;
  hostname?: string;
  oci_image: string;
  icon?: string;
  application_id?: string;
  application_name?: string;
  version?: string;
  status?: string;
  addons?: string[];
  // User/permission info for addon reconfiguration
  username?: string;
  uid?: string;
  gid?: string;
  // Container resource settings (from LXC config)
  memory?: number;
  cores?: number;
  rootfs_storage?: string;
  disk_size?: string;
  bridge?: string;
  // Mount points for existing volumes display
  mount_points?: Array<{ source: string; target: string }>;
}

export type IInstallationsResponse = IManagedOciContainer[];

export type IVeExecuteMessagesResponse = ISingleExecuteMessagesResponse[];
export interface IVeConfigurationResponse {
  success: boolean;
  restartKey?: string;
  vmInstallKey?: string;
}
export interface IFrameworkPropertyObject {
  id: string;
  default: boolean;
}
export type IFrameworkProperty = string | IFrameworkPropertyObject;
export interface IFramework {
  id: string;
  name: string;
  extends: string;
  properties: IFrameworkProperty[];
  icon?: string;
  url?: string;
  documentation?: string;
  source?: string;
  vendor?: string;
  description?: string;
}

export interface IFrameworkName {
  id: string;
  name: string;
}
export interface IFrameworkNamesResponse {
  frameworks: IFrameworkName[];
}
export interface IFrameworkParametersResponse {
  parameters: IParameter[];
}
export interface IPostFrameworkCreateApplicationBody {
  frameworkId: string;
  applicationId: string;
  name: string;
  description: string;
  url?: string;
  documentation?: string;
  source?: string;
  vendor?: string;
  icon?: string;
  iconContent?: string;
  tags?: string[];
  parameterValues: { id: string; value: string | number | boolean }[];
  update?: boolean; // If true, overwrite existing application
}
export interface IPostFrameworkCreateApplicationResponse {
  success: boolean;
  applicationId?: string;
}

export interface IOciImageAnnotations {
  url?: string;
  documentation?: string;
  source?: string;
  vendor?: string;
  description?: string;
}

export interface IPostFrameworkFromImageBody {
  image: string;
  tag?: string;
}

export interface IApplicationDefaults {
  applicationProperties?: {
    name?: string;
    applicationId?: string;
    description?: string;
    url?: string;
    documentation?: string;
    source?: string;
    vendor?: string;
  };
  parameters?: Record<string, string | number | boolean>;
}

export interface IPostFrameworkFromImageResponse {
  annotations: IOciImageAnnotations;
  defaults: IApplicationDefaults;
}

export interface IApplicationFrameworkDataResponse {
  frameworkId: string;
  applicationId: string;
  name: string;
  description: string;
  url?: string;
  documentation?: string;
  source?: string;
  vendor?: string;
  icon?: string;
  iconContent?: string;
  tags?: string[];
  parameterValues: { id: string; value: string | number | boolean }[];
}

// Docker-Compose migration warnings
export type ComposeWarningSeverity = 'info' | 'warning';
export type ComposeWarningCategory = 'unsupported' | 'partial' | 'manual';

export interface IComposeWarning {
  id: string;
  severity: ComposeWarningSeverity;
  category: ComposeWarningCategory;
  feature: string;
  title: string;
  description: string;  // Markdown formatted
  affectedServices?: string[];
}

// Addon interfaces
export interface IAddonVolume {
  id: string;
  mount_point: string;
  default_size?: string;
}

/** Template reference: either a string or object with name and optional before/after */
export type AddonTemplateReference = string | {
  name: string;
  before?: string;
  after?: string;
};

export interface IAddon {
  id: string;
  name: string;
  description?: string;
  tags?: string[];
  compatible_with: string[] | "*";
  /** User-configurable parameters defined directly in addon JSON */
  parameters?: IParameter[];
  /** Fixed property values set by this addon */
  properties?: IOutputObject[];
  volumes?: IAddonVolume[];
  /** Templates to run before container start (on VE/host) */
  pre_start?: AddonTemplateReference[];
  /** Templates to run after container start (inside LXC) */
  post_start?: AddonTemplateReference[];
  /** Templates for copy-upgrade */
  upgrade?: AddonTemplateReference[];
  notes_key: string;
}

/** Addon with extracted parameters from its templates */
export interface IAddonWithParameters extends IAddon {
  /** Parameters extracted from addon templates (pre_start, post_start, upgrade) */
  parameters?: IParameter[];
}

export interface ICompatibleAddonsResponse {
  addons: IAddonWithParameters[];
}
