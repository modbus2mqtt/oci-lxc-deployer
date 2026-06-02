import { ICommand, IManagedOciContainer } from "@src/types.mjs";
import { IVEContext } from "@src/backend-types.mjs";
import { PersistenceManager } from "@src/persistence/persistence-manager.mjs";
import { VeExecution } from "@src/ve-execution/ve-execution.mjs";
import { determineExecutionMode } from "@src/ve-execution/ve-execution-constants.mjs";

/**
 * List all managed OCI containers on a Proxmox host by running
 * list-managed-oci-containers.py via SSH.
 */
export async function listManagedContainers(
  pm: PersistenceManager,
  veContext: IVEContext,
  filterVmId?: number,
): Promise<IManagedOciContainer[]> {
  const repositories = pm.getRepositories();
  const scriptContent = repositories.getScript({
    name: "list-managed-oci-containers.py",
    scope: "shared",
    category: "list",
  });
  if (!scriptContent) {
    throw new Error("list-managed-oci-containers.py not found");
  }

  const libraryContent = repositories.getScript({
    name: "lxc_config_parser_lib.py",
    scope: "shared",
    category: "library",
  });
  if (!libraryContent) {
    throw new Error("lxc_config_parser_lib.py not found");
  }

  const cmd: ICommand = {
    name: "List Managed OCI Containers",
    execute_on: "ve",
    script: "list-managed-oci-containers.py",
    scriptContent,
    libraryContent,
    outputs: ["containers"],
  };

  // When a single vmid is requested (e.g. the application-overview page only
  // needs one container's installed values), pass it as filter_vm_id so the
  // list script parses just that config instead of every config on the host.
  const defaults = new Map<string, string | number | boolean>();
  if (filterVmId !== undefined) {
    defaults.set("filter_vm_id", String(filterVmId));
  }

  const ve = new VeExecution(
    [cmd],
    [],
    veContext,
    defaults,
    undefined,
    determineExecutionMode(),
  );
  await ve.run(null);
  const containersRaw = ve.outputs.get("containers");
  const parsed =
    typeof containersRaw === "string" && containersRaw.trim().length > 0
      ? JSON.parse(containersRaw)
      : [];
  return Array.isArray(parsed) ? parsed : [];
}
