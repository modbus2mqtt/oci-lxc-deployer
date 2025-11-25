import { ICommand, IParameter } from "@src/types.mjs";
import { IJsonErrorDetails } from "@src/jsonvalidator.mjs";
import fs from "fs";
import path from "path";

export class ProxmoxScriptValidator {
  /**
   * Extracts all {{ var }} placeholders from a string.
   */
  private extractTemplateVariables(str: string): string[] {
    const regex = /{{ *([^}\ ]+) *}}/g;
    const vars = new Set<string>();
    let match;
    while ((match = regex.exec(str)) !== null) {
      vars.add(match[1] || "");
    }
    return Array.from(vars);
  }
  private findInPathes(pathes: string[], name: string) {
    // Suche in allen templatePathes nach der ersten existierenden Template-Datei
    let tmplPath: string | undefined = undefined;
    for (const basePath of pathes) {
      const candidate = path.join(basePath, name);
      if (fs.existsSync(candidate)) {
        tmplPath = candidate;
        break;
      }
    }
    return tmplPath;
  }
  /**
   * Checks if the script exists and if all variables are defined as parameters.
   */
  validateScript(
    cmd: ICommand,
    application: string,
    errors: IJsonErrorDetails[],
    parameters: IParameter[],
    resolvedParams: Set<string>,
    requestedIn?: string,
    parentTemplate?: string,
    scriptPathes?: string[],
  ) {
    const scriptPath = this.findInPathes(scriptPathes || [], cmd.execute);
    if (!scriptPath) {
      errors.push(
        new Error(
          `Script file not found: ${cmd.execute} (searched in: applications/${application}/scripts and shared/scripts, requested in: ${requestedIn ?? "unknown"}${parentTemplate ? ", parent template: " + parentTemplate : ""})`,
        ),
      );
      return;
    }
    // Read script content and check variables
    try {
      const scriptContent = fs.readFileSync(scriptPath, "utf-8");
      const vars = this.extractTemplateVariables(scriptContent);
      for (const v of vars) {
        if (!parameters.some((p) => p.name === v) && !resolvedParams.has(v)) {
          errors.push(
            new Error(
              `Script ${cmd.execute} uses variable '{{ ${v} }}' but no such parameter is defined (requested in: ${requestedIn ?? "unknown"}${parentTemplate ? ", parent template: " + parentTemplate : ""})`,
            ),
          );
        }
      }
    } catch (e) {
      errors.push(new Error(`Failed to read script ${cmd.execute}: ${e}`));
    }
  }

  /**
   * Checks if all variables in the execute string are defined as parameters.
   */
  validateCommand(
    cmd: ICommand,
    errors: IJsonErrorDetails[],
    parameters: IParameter[],
    resolvedParams: Set<string>,
    requestedIn?: string,
    parentTemplate?: string,
  ) {
    if (cmd.execute) {
      const vars = this.extractTemplateVariables(cmd.execute);
      for (const v of vars) {
        if (!parameters.some((p) => p.name === v) && !resolvedParams.has(v)) {
          errors.push(
            new Error(
              `Command uses variable '{{ ${v} }}' but no such parameter is defined (requested in: ${requestedIn ?? "unknown"}${parentTemplate ? ", parent template: " + parentTemplate : ""})`,
            ),
          );
        }
      }
    }
  }
}
