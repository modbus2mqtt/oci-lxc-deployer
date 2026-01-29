import express from "express";
import {
  ApiUri,
  TaskType,
  IUnresolvedParametersResponse,
  IPostEnumValuesBody,
  IEnumValuesResponse,
  IApplicationsResponse,
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
        "installation" as TaskType,
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
}
