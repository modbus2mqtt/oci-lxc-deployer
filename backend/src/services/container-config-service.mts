import { ICommand } from "@src/types.mjs";
import { IVEContext } from "@src/backend-types.mjs";
import { PersistenceManager } from "@src/persistence/persistence-manager.mjs";
import { VeExecution } from "@src/ve-execution/ve-execution.mjs";
import { determineExecutionMode } from "@src/ve-execution/ve-execution-constants.mjs";

/** Parsed `/etc/pve/lxc/<vmid>.conf` (the to_dict() output of
 * lxc_config_parser_lib.py). Only the fields consumers currently read are
 * typed; the object may carry more. */
export interface IParsedContainerConfig {
  is_managed?: boolean;
  hostname?: string;
  deploy_params_b64?: string;
  memory?: number;
  cores?: number;
  [key: string]: unknown;
}

/**
 * Read and parse a single container's LXC config by running
 * get-container-config.py via the VE host. Shared by the container-config HTTP
 * route and the reconfigure deploy-params baseline read-back.
 */
export async function getContainerConfig(
  pm: PersistenceManager,
  veContext: IVEContext,
  vmId: number,
): Promise<IParsedContainerConfig> {
  const repositories = pm.getRepositories();
  const scriptContent = repositories.getScript({
    name: "get-container-config.py",
    scope: "shared",
    category: "list",
  });
  if (!scriptContent) {
    throw new Error(
      "get-container-config.py not found (expected in local/shared/scripts/list or json/shared/scripts/list)",
    );
  }

  const libraryContent = repositories.getScript({
    name: "lxc_config_parser_lib.py",
    scope: "shared",
    category: "library",
  });
  if (!libraryContent) {
    throw new Error(
      "lxc_config_parser_lib.py not found (expected in local/shared/scripts/library or json/shared/scripts/library)",
    );
  }

  const cmd: ICommand = {
    name: "Get Container Config",
    execute_on: "ve",
    script: "get-container-config.py",
    scriptContent,
    libraryContent,
    outputs: ["config"],
  };

  const ve = new VeExecution(
    [cmd],
    [{ id: "previous_vm_id", value: vmId }],
    veContext,
    new Map(),
    undefined,
    determineExecutionMode(),
  );
  await ve.run(null);
  const configRaw = ve.outputs.get("config");
  return typeof configRaw === "string" && configRaw.trim().length > 0
    ? (JSON.parse(configRaw) as IParsedContainerConfig)
    : {};
}
