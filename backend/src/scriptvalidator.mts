import { ICommand, IJsonError, IParameter } from "@src/types.mjs";
import fs from "fs";
import path from "path";
import { JsonError } from "./jsonvalidator.mjs";
import { IResolvedParam } from "./backend-types.mjs";

export class ScriptValidator {
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
    errors: IJsonError[],
    parameters: IParameter[],
    resolvedParams: IResolvedParam[],
    requestedIn?: string,
    parentTemplate?: string,
    scriptPathes?: string[],
  ) {
    if (cmd.script === undefined) {
      errors.push(
        new JsonError(
          `Script command missing 'script' property (requested in: ${requestedIn ?? "unknown"}${parentTemplate ? ", parent template: " + parentTemplate : ""})`,
        ),
      );
      return;
    }
    const scriptPath = this.findInPathes(scriptPathes || [], cmd.script);
    if (!scriptPath) {
      errors.push(
        new JsonError(
          `Script file not found: ${cmd.script} (searched in: applications/${application}/scripts and shared/scripts, requested in: ${requestedIn ?? "unknown"}${parentTemplate ? ", parent template: " + parentTemplate : ""})`,
        ),
      );
      return;
    }
    // Read script content and check variables
    try {
      const scriptContent = fs.readFileSync(scriptPath, "utf-8");
      const vars = this.extractTemplateVariables(scriptContent);
      for (const v of vars) {
        if (
          !parameters.some((p) => p.id === v) &&
          !resolvedParams.some((rp) => rp.id === v)
        ) {
          errors.push(
            new JsonError(
              `Script ${cmd.script} uses variable '{{ ${v} }}' but no such parameter is defined (requested in: ${requestedIn ?? "unknown"}${parentTemplate ? ", parent template: " + parentTemplate : ""})`,
            ),
          );
        }
      }
    } catch (e) {
      errors.push(new JsonError(`Failed to read script ${cmd.script}: ${e}`));
    }
  }

  /**
   * Checks if all variables in the execute string are defined as parameters.
   */
  validateCommand(
    cmd: ICommand,
    errors: IJsonError[],
    parameters: IParameter[],
    resolvedParams: IResolvedParam[],
    requestedIn?: string,
    parentTemplate?: string,
  ) {
    if (cmd.command) {
      const vars = this.extractTemplateVariables(cmd.command);
      for (const v of vars) {
        if (
          !parameters.some((p) => p.id === v) &&
          !resolvedParams.some((rp) => rp.id === v)
        ) {
          errors.push(
            new JsonError(
              `Command uses variable '{{ ${v} }}' but no such parameter is defined (requested in: ${requestedIn ?? "unknown"}${parentTemplate ? ", parent template: " + parentTemplate : ""})`,
            ),
          );
        }
      }
    }
  }
}
