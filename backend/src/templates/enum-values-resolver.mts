import { JsonError } from "@src/jsonvalidator.mjs";
import { IResolvedParam } from "@src/backend-types.mjs";
import { ICommand, IJsonError, IParameterValue } from "@src/types.mjs";
import { IVEContext } from "@src/backend-types.mjs";
import { VeExecution } from "../ve-execution/ve-execution.mjs";
import { determineExecutionMode } from "../ve-execution/ve-execution-constants.mjs";
import { IParameterWithTemplate, IProcessTemplateOpts } from "./templateprocessor-types.mjs";

export type ProcessTemplateRunner = (opts: IProcessTemplateOpts) => Promise<void>;
export type EmitMessage = (message: {
  stderr: string;
  result: unknown;
  exitCode: number;
  command: string;
  execute_on: unknown;
  index: number;
}) => void;

export class EnumValuesResolver {
  private static enumValuesCache = new Map<
    string,
    (string | { name: string; value: string | number | boolean })[] | null
  >();

  private normalizeEnumValueInputs(
    inputs?: { id: string; value: IParameterValue }[],
  ): { id: string; value: IParameterValue }[] {
    if (!inputs || inputs.length === 0) return [];
    return inputs
      .filter((item) => item && typeof item.id === "string")
      .map((item) => ({ id: item.id, value: item.value }))
      .sort((a, b) => a.id.localeCompare(b.id));
  }

  private buildEnumValuesCacheKey(
    enumTemplate: string,
    veContext: IVEContext | undefined,
    inputs?: { id: string; value: IParameterValue }[],
  ): string {
    const veKey = veContext?.getKey ? veContext.getKey() : "no-ve";
    const normalizedInputs = this.normalizeEnumValueInputs(inputs);
    return `${veKey}::${enumTemplate}::${JSON.stringify(normalizedInputs)}`;
  }

  async resolveEnumValuesTemplate(
    enumTemplate: string,
    opts: IProcessTemplateOpts,
    processTemplate: ProcessTemplateRunner,
    emitMessage: EmitMessage,
  ): Promise<(string | { name: string; value: string | number | boolean })[] | null | undefined> {
    if (!opts.veContext) return undefined;

    const cacheKey = this.buildEnumValuesCacheKey(
      enumTemplate,
      opts.veContext,
      opts.enumValueInputs,
    );
    const cached = EnumValuesResolver.enumValuesCache.get(cacheKey);

    if (cached !== undefined && !opts.enumValuesRefresh) {
      return cached;
    }

    const tmpCommands: ICommand[] = [];
    const tmpParams: IParameterWithTemplate[] = [];
    const tmpErrors: IJsonError[] = [];
    const tmpResolved: IResolvedParam[] = [];
    const tmpWebui: string[] = [];
    await processTemplate({
      ...opts,
      template: enumTemplate,
      templatename: enumTemplate,
      commands: tmpCommands,
      parameters: tmpParams,
      errors: tmpErrors,
      resolvedParams: tmpResolved,
      webuiTemplates: tmpWebui,
      parentTemplate: typeof opts.template === "string" ? opts.template : opts.template.name,
    });

    if (opts.veContext) {
      try {
        const ve = new VeExecution(
          tmpCommands,
          opts.enumValueInputs ?? [],
          opts.veContext,
          undefined,
          undefined, // sshCommand deprecated - use executionMode instead
          opts.executionMode ?? determineExecutionMode(),
        );
        const rc = await ve.run(null);
        const values =
          rc && Array.isArray(rc.outputs) && rc.outputs.length > 0
            ? rc.outputs
            : null;
        if (values !== null) {
          EnumValuesResolver.enumValuesCache.set(cacheKey, values);
        }
        return values;
      } catch (e: any) {
        if (opts.enumValuesRefresh && cached !== undefined) {
          return cached;
        }
        const err = e instanceof JsonError ? e : new JsonError(String(e?.message ?? e));
        opts.errors?.push(err);
        emitMessage({
          stderr: err.message,
          result: null,
          exitCode: -1,
          command: String(enumTemplate),
          execute_on: undefined,
          index: 0,
        });
      }
    }

    return cached;
  }
}
