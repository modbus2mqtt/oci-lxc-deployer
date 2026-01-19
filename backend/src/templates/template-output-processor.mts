import { JsonError } from "@src/jsonvalidator.mjs";
import { IResolvedParam } from "@src/backend-types.mjs";
import { ITemplate, IJsonError } from "@src/types.mjs";
import { IProcessedTemplate } from "./templateprocessor-types.mjs";

export interface OutputCollectionResult {
  allOutputIds: Set<string>;
  outputIdsFromOutputs: Set<string>;
  outputIdsFromProperties: Set<string>;
  duplicateIds: Set<string>;
}

export interface ApplyOutputsOptions {
  applicationId: string;
  currentTemplateName: string;
  isConditional: boolean;
  outputCollection: OutputCollectionResult;
  resolvedParams: IResolvedParam[];
  outputSources?: Map<string, { template: string; kind: "outputs" | "properties" }>;
  processedTemplates?: Map<string, IProcessedTemplate>;
  errors?: IJsonError[];
}

export type ResolveTemplateFn = (
  applicationId: string,
  templateName: string,
) => { template: ITemplate } | null;
export type NormalizeTemplateNameFn = (templateName: string) => string;

export class TemplateOutputProcessor {
  constructor(
    private resolveTemplate: ResolveTemplateFn,
    private normalizeTemplateName: NormalizeTemplateNameFn,
  ) {}

  collectOutputs(tmplData: ITemplate): OutputCollectionResult {
    const allOutputIds = new Set<string>();
    const outputIdsFromOutputs = new Set<string>();
    const outputIdsFromProperties = new Set<string>();
    const duplicateIds = new Set<string>();
    const seenIds = new Set<string>();

    for (const cmd of tmplData.commands ?? []) {
      if (cmd.outputs) {
        for (const output of cmd.outputs) {
          const id = typeof output === "string" ? output : output.id;
          if (seenIds.has(id)) {
            duplicateIds.add(id);
          } else {
            seenIds.add(id);
            allOutputIds.add(id);
            outputIdsFromOutputs.add(id);
          }
        }
      }

      if (cmd.properties !== undefined) {
        const propertyIds: string[] = [];
        const propertyIdsInCommand = new Set<string>();

        if (Array.isArray(cmd.properties)) {
          for (const prop of cmd.properties) {
            if (prop && typeof prop === "object" && prop.id) {
              if (propertyIdsInCommand.has(prop.id)) {
                duplicateIds.add(prop.id);
              } else {
                propertyIdsInCommand.add(prop.id);
                propertyIds.push(prop.id);
              }
            }
          }
        } else if (cmd.properties && typeof cmd.properties === "object" && cmd.properties.id) {
          propertyIds.push(cmd.properties.id);
        }

        for (const propId of propertyIds) {
          if (seenIds.has(propId)) {
            duplicateIds.add(propId);
          } else {
            seenIds.add(propId);
            allOutputIds.add(propId);
            outputIdsFromProperties.add(propId);
          }
        }
      }
    }

    return {
      allOutputIds,
      outputIdsFromOutputs,
      outputIdsFromProperties,
      duplicateIds,
    };
  }

  applyOutputs(opts: ApplyOutputsOptions): void {
    const {
      applicationId,
      currentTemplateName,
      isConditional,
      outputCollection,
      resolvedParams,
      outputSources,
      processedTemplates,
      errors,
    } = opts;
    const { allOutputIds, outputIdsFromProperties } = outputCollection;

    for (const outputId of allOutputIds) {
      const existing = resolvedParams.find((p) => p.id === outputId);
      if (existing === undefined) {
        resolvedParams.push({
          id: outputId,
          template: currentTemplateName,
        });
        if (outputSources) {
          outputSources.set(outputId, {
            template: currentTemplateName,
            kind: outputIdsFromProperties.has(outputId) ? "properties" : "outputs",
          });
        }
      } else {
        const conflictingTemplate = existing.template;
        if (conflictingTemplate === "user_input") {
          const existingIndex = resolvedParams.findIndex((p) => p.id === outputId);
          if (existingIndex !== -1) {
            resolvedParams[existingIndex] = {
              id: outputId,
              template: currentTemplateName,
            };
          }
          if (outputSources) {
            outputSources.set(outputId, {
              template: currentTemplateName,
              kind: outputIdsFromProperties.has(outputId) ? "properties" : "outputs",
            });
          }
          continue;
        }

        let conflictingTemplateIsConditional = false;
        let conflictingTemplateSetsOutput = true;
        if (processedTemplates) {
          const normalizedConflictingName = this.normalizeTemplateName(conflictingTemplate);
          const conflictingTemplateInfo = processedTemplates.get(normalizedConflictingName);
          if (conflictingTemplateInfo) {
            conflictingTemplateIsConditional = conflictingTemplateInfo.conditional || false;

            try {
              const conflictingResolved = this.resolveTemplate(applicationId, conflictingTemplate);
              const conflictingTmplData = conflictingResolved?.template ?? null;
              if (!conflictingTmplData) {
                conflictingTemplateSetsOutput = true;
              } else {
                conflictingTemplateSetsOutput = false;
                for (const cmd of conflictingTmplData.commands ?? []) {
                  if (cmd.outputs) {
                    for (const output of cmd.outputs) {
                      const id = typeof output === "string" ? output : output.id;
                      if (id === outputId) {
                        conflictingTemplateSetsOutput = true;
                        break;
                      }
                    }
                  }
                  if (cmd.properties !== undefined) {
                    if (Array.isArray(cmd.properties)) {
                      for (const prop of cmd.properties) {
                        if (prop && typeof prop === "object" && prop.id === outputId) {
                          conflictingTemplateSetsOutput = true;
                          break;
                        }
                      }
                    } else if (
                      cmd.properties &&
                      typeof cmd.properties === "object" &&
                      cmd.properties.id === outputId
                    ) {
                      conflictingTemplateSetsOutput = true;
                    }
                  }
                  if (conflictingTemplateSetsOutput) break;
                }
              }
            } catch {
              conflictingTemplateSetsOutput = true;
            }
          }
        }

        if (!conflictingTemplateSetsOutput) {
          const existingIndex = resolvedParams.findIndex((p) => p.id === outputId);
          if (existingIndex !== -1) {
            resolvedParams[existingIndex] = {
              id: outputId,
              template: currentTemplateName,
            };
          }
          if (outputSources) {
            outputSources.set(outputId, {
              template: currentTemplateName,
              kind: outputIdsFromProperties.has(outputId) ? "properties" : "outputs",
            });
          }
        } else if (isConditional || conflictingTemplateIsConditional) {
          const existingIndex = resolvedParams.findIndex((p) => p.id === outputId);
          if (existingIndex !== -1) {
            resolvedParams[existingIndex] = {
              id: outputId,
              template: currentTemplateName,
            };
          }
          if (outputSources) {
            outputSources.set(outputId, {
              template: currentTemplateName,
              kind: outputIdsFromProperties.has(outputId) ? "properties" : "outputs",
            });
          }
        } else {
          errors?.push(
            new JsonError(
              `Output/property ID "${outputId}" is set by multiple templates in the same task: "${conflictingTemplate}" and "${currentTemplateName}". Each output ID can only be set once per task.`,
            ),
          );
        }
      }
    }
  }
}
