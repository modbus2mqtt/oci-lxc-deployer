/**
 * Variable resolver for replacing {{ variable }} placeholders in strings.
 * Supports regular variables and list variables (e.g., {{ volumes }}).
 */
export class VariableResolver {
  constructor(
    private getOutputs: () => Map<string, string | number | boolean>,
    private getInputs: () => Record<string, string | number | boolean>,
    private getDefaults: () => Map<string, string | number | boolean>,
  ) {}

  private get outputs() {
    return this.getOutputs();
  }

  private get inputs() {
    return this.getInputs();
  }

  private get defaults() {
    return this.getDefaults();
  }

  /**
   * Replaces {{var}} in a string with values from inputs or outputs.
   */
  replaceVars(str: string): string {
    return this.replaceVarsWithContext(str, {});
  }

  /**
   * Resolves a list variable by collecting all entries that start with "list.<varName>."
   * from context, outputs, inputs, and defaults, then formats them as a newline-separated
   * list of "parameter-id=value" lines.
   *
   * Example:
   * - list.volumes.volume1 = "/var/libs/myapp/data"
   * - list.volumes.volume2 = "/var/libs/myapp/log"
   * - resolveListVariable("volumes", ctx) returns:
   *   volume1=/var/libs/myapp/data
   *   volume2=/var/libs/myapp/log
   *
   * @param varName The variable name (e.g., "volumes" for {{ volumes }})
   * @param ctx The context map to check first
   * @returns The formatted list string, or null if no list entries found
   */
  resolveListVariable(
    varName: string,
    ctx: Record<string, any>,
  ): string | null {
    const listPrefix = `list.${varName}.`;

    // Collect all matching entries from context, outputs, inputs, and defaults
    const listEntries: Array<{ key: string; value: string }> = [];

    // Check context first
    if (ctx) {
      for (const [key, value] of Object.entries(ctx)) {
        if (
          key.startsWith(listPrefix) &&
          value !== undefined &&
          value !== null
        ) {
          const paramId = key.substring(listPrefix.length);
          listEntries.push({ key: paramId, value: String(value) });
        }
      }
    }

    // Check outputs
    for (const [key, value] of this.outputs.entries()) {
      if (key.startsWith(listPrefix) && value !== undefined && value !== null) {
        const paramId = key.substring(listPrefix.length);
        // Avoid duplicates (context takes precedence)
        if (!listEntries.some((e) => e.key === paramId)) {
          listEntries.push({ key: paramId, value: String(value) });
        }
      }
    }

    // Check inputs
    for (const [key, value] of Object.entries(this.inputs)) {
      if (key.startsWith(listPrefix) && value !== undefined && value !== null) {
        const paramId = key.substring(listPrefix.length);
        // Avoid duplicates (context and outputs take precedence)
        if (!listEntries.some((e) => e.key === paramId)) {
          listEntries.push({ key: paramId, value: String(value) });
        }
      }
    }

    // Check defaults
    for (const [key, value] of this.defaults.entries()) {
      if (key.startsWith(listPrefix) && value !== undefined && value !== null) {
        const paramId = key.substring(listPrefix.length);
        // Avoid duplicates (context, outputs, and inputs take precedence)
        if (!listEntries.some((e) => e.key === paramId)) {
          listEntries.push({ key: paramId, value: String(value) });
        }
      }
    }

    // If we found list entries, format them as "key=value" lines
    if (listEntries.length > 0) {
      // Sort by key for consistent output
      listEntries.sort((a, b) => a.key.localeCompare(b.key));
      return listEntries.map((e) => `${e.key}=${e.value}`).join("\n");
    }

    return null;
  }

  /**
   * Replace variables using a provided context map first (e.g., vmctx.data),
   * then fall back to outputs, inputs, and defaults.
   *
   * Special handling for list variables: Variables like {{ volumes }} will collect
   * all outputs/inputs/defaults that start with "list.volumes." and format them
   * as a newline-separated list of "parameter-id=value" lines.
   *
   * Example:
   * - list.volumes.volume1 = "/var/libs/myapp/data"
   * - list.volumes.volume2 = "/var/libs/myapp/log"
   * - {{ volumes }} becomes:
   *   volume1=/var/libs/myapp/data
   *   volume2=/var/libs/myapp/log
   */
  replaceVarsWithContext(str: string, ctx: Record<string, any>): string {
    return str.replace(/{{\s*([^}\s]+)\s*}}/g, (_: string, v: string) => {
      // Try to resolve as list variable first
      const listResult = this.resolveListVariable(v, ctx);
      if (listResult !== null) {
        return listResult;
      }

      // Fall back to regular variable resolution
      if (ctx && Object.prototype.hasOwnProperty.call(ctx, v)) {
        const val = ctx[v];
        if (val !== undefined && val !== null) return String(val);
      }
      if (this.outputs.has(v)) return String(this.outputs.get(v));
      if (this.inputs[v] !== undefined) return String(this.inputs[v]);
      if (this.defaults.has(v)) return String(this.defaults.get(v));
      // Return "NOT_DEFINED" for undefined variables instead of throwing error
      // Scripts must check for this value and generate appropriate error messages
      return "NOT_DEFINED";
    });
  }
}
