import express from "express";
import {
  ApiUri,
  TaskType,
  IUnresolvedParametersResponse,
  IPostEnumValuesBody,
  IEnumValuesResponse,
  IApplicationsResponse,
  ITagsConfigResponse,
  IApplicationFrameworkDataResponse,
  ICompatibleAddonsResponse,
} from "@src/types.mjs";
import { ContextManager } from "../context-manager.mjs";
import { PersistenceManager } from "../persistence/persistence-manager.mjs";
import { ITemplateProcessorLoadResult } from "../templates/templateprocessor.mjs";
import { getErrorStatusCode, serializeError } from "./webapp-error-utils.mjs";

type ReturnResponse = <T>(
  res: express.Response,
  payload: T,
  statusCode?: number,
) => void;

export function registerApplicationRoutes(
  app: express.Application,
  storageContext: ContextManager,
  returnResponse: ReturnResponse,
): void {
  app.get(ApiUri.UnresolvedParameters, async (req, res) => {
    try {
      const application: string = req.params.application;
      const taskKey: string = req.params.task;
      const veContextKey: string = req.params.veContext;
      if (!taskKey) {
        return res.status(400).json({ success: false, error: "Missing task" });
      }
      const ctx = storageContext.getVEContextByKey(veContextKey);
      if (!ctx) {
        return res
          .status(404)
          .json({ success: false, error: "VE context not found" });
      }
      const templateProcessor = storageContext.getTemplateProcessor();
      const unresolved = await templateProcessor.getUnresolvedParameters(
        application,
        taskKey as TaskType,
        ctx,
      );
      returnResponse<IUnresolvedParametersResponse>(res, {
        unresolvedParameters: unresolved,
      });
    } catch (err: any) {
      const statusCode = getErrorStatusCode(err);
      const serializedError = serializeError(err);
      return res.status(statusCode).json({
        success: false,
        error: err instanceof Error ? err.message : String(err),
        serializedError: serializedError,
      });
    }
  });

  app.get(ApiUri.Applications, (_req, res) => {
    try {
      const pm = PersistenceManager.getInstance();
      const applications = pm
        .getApplicationService()
        .listApplicationsForFrontend();
      const payload: IApplicationsResponse = applications;
      res.json(payload).status(200);
    } catch (err: any) {
      const serializedError = serializeError(err);
      res.status(500).json({
        error: err instanceof Error ? err.message : String(err),
        serializedError: serializedError,
      });
    }
  });

  app.get(ApiUri.LocalApplicationIds, (_req, res) => {
    try {
      const pm = PersistenceManager.getInstance();
      const localAppNames = pm
        .getApplicationService()
        .getLocalAppNames();
      const ids = Array.from(localAppNames.keys());
      res.json(ids).status(200);
    } catch (err: any) {
      const serializedError = serializeError(err);
      res.status(500).json({
        error: err instanceof Error ? err.message : String(err),
        serializedError: serializedError,
      });
    }
  });

  app.get(ApiUri.ApplicationTags, (_req, res) => {
    try {
      const pm = PersistenceManager.getInstance();
      const tagsConfig = pm.getTagsConfig();
      returnResponse<ITagsConfigResponse>(res, tagsConfig);
    } catch (err: any) {
      const serializedError = serializeError(err);
      res.status(500).json({
        error: err instanceof Error ? err.message : String(err),
        serializedError: serializedError,
      });
    }
  });

  app.post(ApiUri.EnumValues, express.json(), async (req, res) => {
    try {
      const application: string = req.params.application;
      const task: string = req.params.task;
      const veContextKey: string = req.params.veContext;
      if (!task) {
        return res.status(400).json({ success: false, error: "Missing task" });
      }
      const ctx = storageContext.getVEContextByKey(veContextKey);
      if (!ctx) {
        return res
          .status(404)
          .json({ success: false, error: "VE context not found" });
      }

      const body = (req.body || {}) as IPostEnumValuesBody;
      if (body.params !== undefined && !Array.isArray(body.params)) {
        return res
          .status(400)
          .json({ success: false, error: "Invalid parameters" });
      }
      const params = body.params ?? [];
      if (params.some((p) => !p || typeof p.id !== "string")) {
        return res
          .status(400)
          .json({ success: false, error: "Invalid parameters" });
      }

      const templateProcessor = storageContext.getTemplateProcessor();
      const loaded = await templateProcessor.loadApplication(
        application,
        task as TaskType,
        ctx,
        undefined,
        params,
        false,
      );

      const enumValues = loaded.parameters
        .filter((param) => param.type === "enum" && param.enumValues !== undefined)
        .map((param) => ({
          id: param.id,
          enumValues: param.enumValues!,
          ...(param.default !== undefined ? { default: param.default } : {}),
        }));

      returnResponse<IEnumValuesResponse>(res, {
        enumValues,
      });
    } catch (err: any) {
      const statusCode = getErrorStatusCode(err);
      const serializedError = serializeError(err);
      return res.status(statusCode).json({
        success: false,
        error: err instanceof Error ? err.message : String(err),
        serializedError: serializedError,
      });
    }
  });

  app.get(ApiUri.TemplateDetailsForApplication, async (req, res) => {
    try {
      const veContext = storageContext.getVEContextByKey(req.params.veContext);
      if (!veContext) {
        return res
          .status(404)
          .json({ success: false, error: "VE context not found" });
      }
      const application = await storageContext
        .getTemplateProcessor()
        .loadApplication(
          req.params.application,
          req.params.task as TaskType,
          veContext,
        );
      returnResponse<ITemplateProcessorLoadResult>(res, application);
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  app.get(ApiUri.ApplicationFrameworkData, (req, res) => {
    try {
      const applicationId = req.params.applicationId;
      if (!applicationId) {
        return res.status(400).json({ error: "Missing applicationId" });
      }

      const pm = PersistenceManager.getInstance();
      const appService = pm.getApplicationService();

      // Check if application exists in local directory
      const localAppNames = appService.getLocalAppNames();
      if (!localAppNames.has(applicationId)) {
        return res.status(404).json({ error: `Application ${applicationId} not found in local applications` });
      }

      // Read application.json
      const application = appService.readApplication(applicationId, {
        applicationHierarchy: [],
        error: { message: "", name: "Error", details: undefined },
        taskTemplates: [],
      });

      // Check if application has a framework (extends property pointing to a framework base)
      if (!application.extends) {
        return res.status(400).json({ error: `Application ${applicationId} is not framework-based (no extends property)` });
      }

      // Read the parameters template (<appId>-parameters.json)
      const appPath = localAppNames.get(applicationId)!;
      const parametersTemplatePath = `${appPath}/templates/${applicationId}-parameters.json`;
      let parametersTemplate: any = null;
      try {
        parametersTemplate = pm.getPersistence().loadTemplate(parametersTemplatePath);
      } catch {
        // Parameters template might not exist for older applications
      }

      // Extract parameter values from the template
      const parameterValues: { id: string; value: string | number | boolean }[] = [];

      if (parametersTemplate) {
        // Extract from parameters array (default values)
        if (parametersTemplate.parameters) {
          for (const param of parametersTemplate.parameters) {
            if (param.default !== undefined) {
              parameterValues.push({ id: param.id, value: param.default });
            }
          }
        }

        // Extract from commands[].properties (output values)
        if (parametersTemplate.commands) {
          for (const cmd of parametersTemplate.commands) {
            if (cmd.properties) {
              const props = Array.isArray(cmd.properties) ? cmd.properties : [cmd.properties];
              for (const prop of props) {
                if (prop.id && prop.value !== undefined) {
                  // Don't duplicate if already in parameterValues
                  if (!parameterValues.some(pv => pv.id === prop.id)) {
                    parameterValues.push({ id: prop.id, value: prop.value });
                  }
                }
              }
            }
          }
        }
      }

      // Read icon if exists
      let iconContent: string | undefined;
      if (application.icon) {
        try {
          const iconData = appService.readApplicationIcon(applicationId);
          if (iconData) {
            iconContent = iconData.iconContent;
          }
        } catch {
          // Icon might not exist
        }
      }

      const response: IApplicationFrameworkDataResponse = {
        frameworkId: application.extends,
        applicationId,
        name: application.name,
        description: application.description,
        parameterValues,
      };

      // Add optional properties only if they have values
      if (application.url) response.url = application.url;
      if (application.documentation) response.documentation = application.documentation;
      if (application.source) response.source = application.source;
      if (application.vendor) response.vendor = application.vendor;
      if (application.icon) response.icon = application.icon;
      if (iconContent) response.iconContent = iconContent;
      if (application.tags && application.tags.length > 0) response.tags = application.tags;
      if ((application as any).tracktype) response.stacktype = (application as any).tracktype;

      returnResponse<IApplicationFrameworkDataResponse>(res, response);
    } catch (err: any) {
      const statusCode = getErrorStatusCode(err);
      const serializedError = serializeError(err);
      res.status(statusCode).json({
        error: err instanceof Error ? err.message : String(err),
        serializedError: serializedError,
      });
    }
  });

  app.get(ApiUri.CompatibleAddons, (req, res) => {
    try {
      const applicationId = req.params.application;

      if (!applicationId) {
        return res.status(400).json({ error: "Missing application" });
      }

      // Note: VE context is not required for addon compatibility check
      // Addon compatibility depends only on application metadata

      const pm = PersistenceManager.getInstance();
      const appService = pm.getApplicationService();
      const addonService = pm.getAddonService();

      // Read the application
      const application = appService.readApplication(applicationId, {
        applicationHierarchy: [],
        error: { message: "", name: "Error", details: undefined },
        taskTemplates: [],
      });

      // Get compatible addons with extracted parameters from addon templates
      const compatibleAddons = addonService.getCompatibleAddonsWithParameters(application);

      returnResponse<ICompatibleAddonsResponse>(res, {
        addons: compatibleAddons,
      });
    } catch (err: any) {
      const statusCode = getErrorStatusCode(err);
      const serializedError = serializeError(err);
      res.status(statusCode).json({
        error: err instanceof Error ? err.message : String(err),
        serializedError: serializedError,
      });
    }
  });
}
