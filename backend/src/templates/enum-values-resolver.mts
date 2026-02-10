import { JsonError } from "@src/jsonvalidator.mjs";
import { IResolvedParam } from "@src/backend-types.mjs";
import { ICommand, IJsonError, IParameterValue } from "@src/types.mjs";
import { IVEContext } from "@src/backend-types.mjs";
import { VeExecution } from "../ve-execution/ve-execution.mjs";
import { determineExecutionMode } from "../ve-execution/ve-execution-constants.mjs";
import {
  IParameterWithTemplate,
  IProcessTemplateOpts,
} from "./templateprocessor-types.mjs";

export type ProcessTemplateRunner = (
  opts: IProcessTemplateOpts,
) => Promise<void>;
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
  private static enumValuesInFlight = new Map<
    string,
    Promise<
      | (string | { name: string; value: string | number | boolean })[]
      | null
      | undefined
    >
  >();

  static invalidateForVeKey(veKey: string | null | undefined): void {
    if (!veKey) return;
    const prefix = `${veKey}::`;
    for (const key of Array.from(EnumValuesResolver.enumValuesCache.keys())) {
      if (key.startsWith(prefix)) {
        EnumValuesResolver.enumValuesCache.delete(key);
      }
    }
  }

  private normalizeEnumValueInputs(
    inputs?: { id: string; value: IParameterValue }[],
  ): { id: string; value: IParameterValue }[] {
    if (!inputs || inputs.length === 0) return [];
    return inputs
      .filter((item) => item && typeof item.id === "string")
      .map((item) => ({ id: item.id, value: item.value }))
      .sort((a, b) => a.id.localeCompare(b.id));
  }

  private normalizeEnumTemplateName(enumTemplate: string): string {
    return enumTemplate.replace(/\.json$/i, "");
  }

  private withApplicationInput(
    inputs: { id: string; value: IParameterValue }[] | undefined,
    executeOn: string | undefined,
    application: string,
  ): { id: string; value: IParameterValue }[] | undefined {
    if (!executeOn || !executeOn.startsWith("application:")) return inputs;
    const raw = executeOn.slice("application:".length).trim();
    const appId = raw.length > 0 ? raw : application;
    if (!appId) return inputs;
    const normalized = this.normalizeEnumValueInputs(inputs);
    const hasAppId = normalized.some((item) => item.id === "application_id");
    if (hasAppId) return normalized;
    return [...normalized, { id: "application_id", value: appId }];
  }

  private buildEnumValuesCacheKey(
    enumTemplate: string,
    veContext: IVEContext | undefined,
    executeOn: string | undefined,
    inputs?: { id: string; value: IParameterValue }[],
  ): string {
    const veKey = veContext?.getKey ? veContext.getKey() : "no-ve";
    const normalizedTemplate = this.normalizeEnumTemplateName(enumTemplate);
    const normalizedInputs = this.normalizeEnumValueInputs(inputs);
    const execKey =
      typeof executeOn === "string" && executeOn.length > 0
        ? executeOn
        : "default";
    return `${veKey}::${execKey}::${normalizedTemplate}::${JSON.stringify(normalizedInputs)}`;
  }

  async resolveEnumValuesTemplate(
    enumTemplate: string,
    opts: IProcessTemplateOpts,
    processTemplate: ProcessTemplateRunner,
    emitMessage: EmitMessage,
  ): Promise<
    | (string | { name: string; value: string | number | boolean })[]
    | null
    | undefined
  > {
    if (!opts.veContext) return undefined;

    const effectiveInputs = this.withApplicationInput(
      opts.enumValueInputs,
      opts.enumValuesExecuteOn,
      opts.application,
    );
    const cacheKey = this.buildEnumValuesCacheKey(
      enumTemplate,
      opts.veContext,
      opts.enumValuesExecuteOn,
      effectiveInputs,
    );
    const legacyKey = `${opts.veContext?.getKey ? opts.veContext.getKey() : "no-ve"}::${enumTemplate}::${JSON.stringify(
      this.normalizeEnumValueInputs(effectiveInputs),
    )}`;
    const cached =
      EnumValuesResolver.enumValuesCache.get(cacheKey) ??
      EnumValuesResolver.enumValuesCache.get(legacyKey);

    if (cached !== undefined && !opts.enumValuesRefresh) {
      if (
        cached !== null &&
        !EnumValuesResolver.enumValuesCache.has(cacheKey)
      ) {
        EnumValuesResolver.enumValuesCache.set(cacheKey, cached);
      }
      if (process.env.ENUM_TRACE === "1" || process.env.CACHE_TRACE === "1") {
        const parent =
          typeof opts.template === "string"
            ? opts.template
            : opts.template.name;
        console.info(
          `[enum-trace] cache-hit enumTemplate=${enumTemplate} parent=${parent} key=${cacheKey}`,
        );
      }
      return cached;
    }

    if (cached !== undefined && opts.enumValuesRefresh) {
      const refreshKey = `${cacheKey}::refresh`;
      if (!EnumValuesResolver.enumValuesInFlight.has(refreshKey)) {
        const runner = (async (): Promise<
          | (string | { name: string; value: string | number | boolean })[]
          | null
          | undefined
        > => {
          try {
            if (process.env.ENUM_TRACE === "1") {
              const parent =
                typeof opts.template === "string"
                  ? opts.template
                  : opts.template.name;
              console.info(
                `[enum-trace] refresh execute enumTemplate=${enumTemplate} parent=${parent} key=${cacheKey}`,
              );
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
              parentTemplate:
                typeof opts.template === "string"
                  ? opts.template
                  : opts.template.name,
            });
            if (opts.veContext) {
              const ve = new VeExecution(
                tmpCommands,
                effectiveInputs ?? [],
                opts.veContext,
                undefined,
                undefined,
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
            }
          } catch {
            // keep cached value on refresh failures
          }
          return cached;
        })();
        EnumValuesResolver.enumValuesInFlight.set(refreshKey, runner);
        runner.finally(() =>
          EnumValuesResolver.enumValuesInFlight.delete(refreshKey),
        );
      }
      return cached;
    }

    const inFlightKey = opts.enumValuesRefresh
      ? `${cacheKey}::refresh`
      : cacheKey;
    const inFlight = EnumValuesResolver.enumValuesInFlight.get(inFlightKey);
    if (inFlight) {
      if (process.env.ENUM_TRACE === "1") {
        const parent =
          typeof opts.template === "string"
            ? opts.template
            : opts.template.name;
        console.info(
          `[enum-trace] in-flight enumTemplate=${enumTemplate} parent=${parent} key=${cacheKey}`,
        );
      }
      return await inFlight;
    }
    const runner = (async () => {
      if (process.env.ENUM_TRACE === "1") {
        const parent =
          typeof opts.template === "string"
            ? opts.template
            : opts.template.name;
        console.info(
          `[enum-trace] execute enumTemplate=${enumTemplate} parent=${parent} key=${cacheKey}`,
        );
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
        parentTemplate:
          typeof opts.template === "string"
            ? opts.template
            : opts.template.name,
      });

      if (opts.veContext) {
        try {
          const ve = new VeExecution(
            tmpCommands,
            effectiveInputs ?? [],
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
          const err =
            e instanceof JsonError ? e : new JsonError(String(e?.message ?? e));
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
    })();

    EnumValuesResolver.enumValuesInFlight.set(inFlightKey, runner);
    try {
      return await runner;
    } finally {
      EnumValuesResolver.enumValuesInFlight.delete(inFlightKey);
    }
  }
}
