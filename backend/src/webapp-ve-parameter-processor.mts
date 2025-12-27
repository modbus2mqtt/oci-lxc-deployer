import fs from "fs";
import path from "path";
import { StorageContext } from "./storagecontext.mjs";
import { IVEContext } from "./backend-types.mjs";
import { IParameter, IPostVeConfigurationBody, TaskType } from "./types.mjs";

/**
 * Processes parameters for VE configuration, including file uploads and vmInstallContext.
 */
export class WebAppVeParameterProcessor {
  /**
   * Processes parameters: for upload parameters with "local:" prefix, reads file and base64 encodes.
   */
  async processParameters(
    params: IPostVeConfigurationBody["params"],
    loadedParameters: IParameter[],
    storageContext: StorageContext,
  ): Promise<Array<{ id: string; value: string | number | boolean }>> {
    return await Promise.all(
      params.map(async (p) => {
        const paramDef = loadedParameters.find(
          (param) => param.id === p.name,
        );
        if (
          paramDef?.upload &&
          typeof p.value === "string" &&
          p.value.startsWith("local:")
        ) {
          const filePath = p.value.substring(6); // Remove "local:" prefix
          const localPath = storageContext.getLocalPath();
          const fullPath = path.join(localPath, filePath);
          try {
            const fileContent = fs.readFileSync(fullPath);
            const base64Content = fileContent.toString("base64");
            return { id: p.name, value: base64Content };
          } catch (err: any) {
            throw new Error(
              `Failed to read file ${fullPath}: ${err.message}`,
            );
          }
        }
        return { id: p.name, value: p.value };
      }),
    );
  }

  /**
   * Builds a defaults map from loaded parameters.
   */
  buildDefaults(loadedParameters: IParameter[]): Map<string, string | number | boolean> {
    const defaults = new Map<string, string | number | boolean>();
    loadedParameters.forEach((param) => {
      const p = defaults.get(param.name);
      if (!p && param.default !== undefined) {
        // do not overwrite existing defaults
        defaults.set(param.id, param.default);
      }
    });
    return defaults;
  }

  /**
   * Saves vmInstallContext if changedParams are provided.
   * Returns the vmInstallKey if context was saved, undefined otherwise.
   */
  saveVmInstallContext(
    changedParams: IPostVeConfigurationBody["changedParams"] | undefined,
    veContext: IVEContext,
    application: string,
    task: TaskType,
    storageContext: StorageContext,
  ): string | undefined {
    if (changedParams && changedParams.length > 0) {
      const hostname = typeof veContext.host === "string" 
        ? veContext.host 
        : (veContext.host as any)?.host || "unknown";
      return storageContext.setVMInstallContext({
        hostname,
        application,
        task,
        changedParams: changedParams.map(p => ({ name: p.name, value: p.value })),
      });
    }
    return undefined;
  }
}

