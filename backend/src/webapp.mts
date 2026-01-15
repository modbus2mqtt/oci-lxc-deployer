import express from "express";
import {
  TaskType,
  ISsh,
  ApiUri,
  IUnresolvedParametersResponse,
  IApplicationsResponse,
  ISshConfigsResponse,
  ISshConfigKeyResponse,
  ISshCheckResponse,
  ISetSshConfigResponse,
  IDeleteSshConfigResponse,
  IJsonError,
  IFrameworkNamesResponse,
  IFrameworkParametersResponse,
  IPostFrameworkCreateApplicationBody,
  IPostFrameworkCreateApplicationResponse,
  IPostFrameworkFromImageBody,
  IPostFrameworkFromImageResponse,
  IOciImageAnnotations,
  IInstallationsResponse,
  ICommand,
} from "@src/types.mjs";
import http from "http";
import path from "path";
import { fileURLToPath } from "node:url";
import fs from "fs";
import { PersistenceManager } from "./persistence/persistence-manager.mjs";
import { ContextManager } from "./context-manager.mjs";
import { Ssh } from "./ssh.mjs";
import { IVEContext, VEConfigurationError } from "./backend-types.mjs";
import { ITemplateProcessorLoadResult } from "./templateprocessor.mjs";
import { WebAppVE } from "./webapp-ve.mjs";
import { JsonError } from "./jsonvalidator.mjs";
import { FrameworkLoader } from "./frameworkloader.mjs";
import { FrameworkFromImage } from "./framework-from-image.mjs";
import { VeExecution } from "./ve-execution.mjs";
import { determineExecutionMode } from "./ve-execution-constants.mjs";
export class VEWebApp {
  app: express.Application;
  public httpServer: http.Server;
  returnResponse<T>(
    res: express.Response,
    payload: T,
    statusCode: number = 200,
  ) {
    res.status(statusCode).json(payload);
  }

  /**
   * Determines the appropriate HTTP status code for an error.
   * Returns 422 (Unprocessable Entity) for validation/configuration errors,
   * 500 (Internal Server Error) for unexpected server errors.
   */
  private getErrorStatusCode(err: unknown): number {
    // Check if error is a validation/configuration error
    if (err instanceof JsonError || err instanceof VEConfigurationError) {
      return 422; // Unprocessable Entity - validation/configuration error
    }
    // Check if error has a name property indicating it's a validation error
    if (err && typeof err === 'object' && 'name' in err) {
      const errorName = (err as { name?: string }).name;
      if (errorName === 'JsonError' || errorName === 'VEConfigurationError' || errorName === 'ValidateJsonError') {
        return 422;
      }
    }
    // Default to 500 for unexpected errors
    return 500;
  }

  /**
   * Recursively serializes an array of details, handling both JsonError instances and plain objects.
   */
  private serializeDetailsArray(details: IJsonError[] | undefined): IJsonError[] | undefined {
    if (!details || !Array.isArray(details)) {
      return undefined;
    }
    
    return details.map((d) => {
      // If it's a JsonError instance with toJSON, use it
      if (d && typeof d === 'object' && typeof (d as any).toJSON === "function") {
        return (d as any).toJSON();
      }
      
      // If it's already a plain object with the expected structure, ensure details are serialized
      if (d && typeof d === 'object') {
        const result: any = {
          name: (d as any).name,
          message: (d as any).message,
          line: (d as any).line,
        };
        
        // Recursively serialize nested details if they exist
        if ((d as any).details && Array.isArray((d as any).details)) {
          result.details = this.serializeDetailsArray((d as any).details);
        }
        
        if ((d as any).filename !== undefined) result.filename = (d as any).filename;
        
        return result as IJsonError;
      }
      
      // Fallback: convert to string or return as-is
      return {
        name: 'Error',
        message: String(d),
        details: undefined
      } as IJsonError;
    });
  }

  /**
   * Converts an error to a serializable JSON object.
   * Uses toJSON() if available, otherwise extracts error properties.
   */
  private serializeError(err: unknown): any {
    if (!err) {
      return { message: "Unknown error" };
    }

    // If error has a toJSON method, use it
    if (err && typeof err === 'object' && 'toJSON' in err && typeof (err as any).toJSON === 'function') {
      return (err as any).toJSON();
    }

    // If it's an Error instance, extract properties
    if (err instanceof Error) {
      const errorObj: any = {
        name: err.name,
        message: err.message,
      };
      
      // Add stack trace in development (optional)
      if (process.env.NODE_ENV !== 'production' && err.stack) {
        errorObj.stack = err.stack;
      }

      // If it's a JsonError or VEConfigurationError, try to get details
      if (err instanceof JsonError || err instanceof VEConfigurationError) {
        // Use toJSON() if available to ensure proper recursive serialization
        if (typeof (err as any).toJSON === 'function') {
          return (err as any).toJSON();
        }
        
        // Fallback: manually extract details and serialize them
        if ((err as any).details) {
          errorObj.details = this.serializeDetailsArray((err as any).details);
        }
        if ((err as any).filename) {
          errorObj.filename = (err as any).filename;
        }
      }

      return errorObj;
    }

    // For other types, try to convert to string or return as-is
    if (typeof err === 'string') {
      return { message: err };
    }

    // Last resort: try to serialize the object
    try {
      return JSON.parse(JSON.stringify(err));
    } catch {
      return { message: String(err) };
    }
  }
  constructor(private storageContext:  ContextManager) {
    this.app = express();
    this.httpServer = http.createServer(this.app);
    // No socket.io needed anymore

    // Serve Angular static files (built frontend)
    const __filename = fileURLToPath(import.meta.url);
    const __dirname = path.dirname(__filename);
    // fs imported from ESM above
    // Allow configuration via ENV or package.json
    // ENV has precedence: absolute or relative to repo root
    let configuredRel: string | undefined =
      process.env.LXC_MANAGER_FRONTEND_DIR;
    try {
      const rootPkg = path.join(__dirname, "../../package.json");
      if (fs.existsSync(rootPkg)) {
        const pkg = JSON.parse(fs.readFileSync(rootPkg, "utf-8"));
        if (
          pkg &&
          pkg.lxcManager &&
          pkg.lxcManager.frontendDir &&
          !configuredRel
        ) {
          configuredRel = String(pkg.lxcManager.frontendDir);
        }
      }
    } catch {}

    const repoRoot = path.join(__dirname, "../../");
    const candidates: string[] = [];
    if (configuredRel) {
      // support absolute or relative path
      candidates.push(
        path.isAbsolute(configuredRel)
          ? configuredRel
          : path.join(repoRoot, configuredRel),
      );
    }
    // Fallbacks
    candidates.push(
      path.join(__dirname, "../../frontend/dist/webapp-angular/browser"),
      path.join(__dirname, "../../frontend/dist"),
      path.join(__dirname, "../../frontend/dist/frontend"),
      path.join(__dirname, "../webapp-angular"),
    );
    const staticDir = candidates.find((p) => {
      try {
        return fs.existsSync(p) && fs.statSync(p).isDirectory();
      } catch {
        return false;
      }
    });
    if (staticDir) {
      this.app.use(express.static(staticDir));
      this.app.get("/", (_req, res) => {
        res.sendFile(path.join(staticDir, "index.html"));
      });
    }

    // SSH config API
    this.app.get(ApiUri.SshConfigs, (req, res) => {
      try {
        const sshs: ISsh[] = storageContext.listSshConfigs();
        const key = storageContext.getCurrentVEContext()?.getKey();
        // Always include publicKeyCommand, even if no SSH configs exist
        const publicKeyCommand = Ssh.getPublicKeyCommand() || undefined;
        // installSshServer is only included in individual SSH configs if port is not listening
        // We don't include it in the top-level response since it depends on the specific host
        this.returnResponse<ISshConfigsResponse>(res, { 
          sshs, 
          key,
          publicKeyCommand
        });
      } catch (err: any) {
        res.status(500).json({ error: err.message });
      }
    });
    // Get SSH config key by host (mandatory path param)
    this.app.get(ApiUri.SshConfigGET, (req, res) => {
      try {
        const host = String(req.params.host || "").trim();
        if (!host) {
          res.status(400).json({ error: "Missing host" });
          return;
        }
        const key = `ve_${host}`;
        if (!storageContext.has(key)) {
          res.status(404).json({ error: "SSH config not found" });
          return;
        }
        this.returnResponse<ISshConfigKeyResponse>(res, { key });
      } catch (err: any) {
        res.status(500).json({ error: err.message });
      }
    });
    // Check SSH permission for host/port
    this.app.get(ApiUri.SshCheck, (req, res) => {
      try {
        const host = String(req.query.host || "").trim();
        const portRaw = req.query.port as string | undefined;
        const port = portRaw ? Number(portRaw) : undefined;
        if (!host) {
          res.status(400).json({ error: "Missing host" });
          return;
        }
        const result = Ssh.checkSshPermission(host, port);
        this.returnResponse<ISshCheckResponse>(res, result);
      } catch (err: any) {
        res.status(500).json({ error: err.message });
      }
    });

    this.app.post(ApiUri.SshConfig, express.json(), (req, res) => {
      const body = req.body as Partial<ISsh> | undefined;
      const host = body?.host;
      const port = body?.port;
      const current = body?.current === true;
      // publicKeyCommand must never be persisted; ignore it from payload
      if (!host || typeof host !== "string" || typeof port !== "number") {
        res.status(400).json({
          error:
            "Invalid SSH config. Must provide host (string) and port (number).",
        });
        return;
      }
      try {
        // Add or update VE context
        var currentKey: string | undefined = storageContext.setVEContext({
          host,
          port,
          current,
        } as IVEContext);
        // If set as current, unset others
        if (current === true) {
          for (const key of storageContext
            .keys()
            .filter((k) => k.startsWith("ve_") && k !== `ve_${host}`)) {
            const ctx: any = storageContext.get(key) || {};
            const updated = { ...ctx, current: false };
            storageContext.setVEContext(updated);
          }
        } else currentKey = undefined;
        this.returnResponse<ISetSshConfigResponse>(res, {
          success: true,
          key: currentKey,
        });
      } catch (err: any) {
        res.status(500).json({ error: err.message });
      }
    });
    this.app.get<String>(ApiUri.SshConfig, (req, res) => {
      try {
        const veContext = storageContext.getCurrentVEContext();
        if (!veContext) {
          res
            .status(404)
            .json({
              error: "No default SSH config available. Please configure first",
            });
          return;
        }
        const key = veContext.getKey();
        this.returnResponse<ISshConfigKeyResponse>(res, { key });
      } catch (err: any) {
        res.status(500).json({ error: err.message });
      }
    });
    // Delete SSH config by host (port currently ignored in keying)
    this.app.delete(ApiUri.SshConfig, (req, res) => {
      try {
        const host =
          String(req.query.host || "").trim() ||
          String((req.body as any)?.host || "").trim();
        if (!host) {
          res.status(400).json({ error: "Missing host" });
          return;
        }
        const key = `ve_${host}`;
        if (!storageContext.has(key)) {
          // Consider non-existent as success for idempotency
          this.returnResponse<IDeleteSshConfigResponse>(res, {
            success: true,
            deleted: false,
          });
          return;
        }
        storageContext.remove(key);
        // If the removed one was current, set another VE as current (first found)
        const remainingKeys: string[] = storageContext
          .keys()
          .filter((k: string) => k.startsWith("ve_"));
        var currentKey: string | undefined = undefined;
        if (remainingKeys.length > 0 && remainingKeys[0] !== undefined) {
          // Choose first and mark as current
          currentKey = remainingKeys[0];
          const ctx: any = storageContext.get(currentKey) || {};
          const updated = { ...ctx, current: true };
          storageContext.set(currentKey, updated);
        }
        this.returnResponse<IDeleteSshConfigResponse>(res, {
          success: true,
          deleted: true,
          key: currentKey,
        });
      } catch (err: any) {
        res.status(500).json({ error: err.message });
      }
    });

    // Set an existing SSH config as current (by host). Unset others.
    this.app.put(ApiUri.SshConfig, express.json(), (req, res) => {
      try {
        const rawHost =
          (req.query.host as string | undefined) ??
          ((req.body as any)?.host as string | undefined);
        const host = rawHost ? String(rawHost).trim() : "";
        if (!host) {
          res.status(400).json({ error: "Missing host" });
          return;
        }
        const key: string = `ve_${host}`;
        if (!storageContext.has(key)) {
          res.status(404).json({ error: "SSH config not found" });
          return;
        }
        // Unset current for all others
        for (const k of storageContext
          .keys()
          .filter((k: string) => k.startsWith("ve_") && k !== key)) {
          const ctx: any = storageContext.get(k) || {};
          storageContext.set(k, { ...ctx, current: false });
        }
        // Set this one as current
        const curCtx: any = storageContext.get(key) || {};
        storageContext.set(key, { ...curCtx, current: true });
        this.returnResponse<ISetSshConfigResponse>(res, { success: true, key });
      } catch (err: any) {
        res.status(500).json({ error: err.message });
      }
    });

    // GET /api/unresolved-parameters/:application/:task?veContext=<key>
    this.app.get(ApiUri.UnresolvedParameters, async (req, res) => {
      try {
        const application: string = req.params.application;
        const task: string = req.params.task;
        const veContextKey: string = req.params.veContext;
        const ctx: IVEContext | null =
          this.storageContext.getVEContextByKey(veContextKey);
        if (!ctx) {
          return res
            .status(404)
            .json({ success: false, error: "VE context not found" });
        }
        const templateProcessor = storageContext.getTemplateProcessor();
        const unresolved = await templateProcessor.getUnresolvedParameters(
          application,
          task as TaskType,
          ctx,
        );
        this.returnResponse<IUnresolvedParametersResponse>(res, {
          unresolvedParameters: unresolved,
        });
      } catch (err: any) {
        const statusCode = this.getErrorStatusCode(err);
        const serializedError = this.serializeError(err);
        return res
          .status(statusCode)
          .json({ 
            success: false, 
            error: err instanceof Error ? err.message : String(err),
            serializedError: serializedError 
          });
      }
    });
    this.app.get(ApiUri.Applications, (req, res) => {
      try {
        const pm = PersistenceManager.getInstance();
        const applications = pm.getApplicationService().listApplicationsForFrontend();
        const payload: IApplicationsResponse = applications;
        res.json(payload).status(200);
      } catch (err: any) {
        const serializedError = this.serializeError(err);
        res.status(500).json({ 
          error: err instanceof Error ? err.message : String(err),
          serializedError: serializedError 
        });
      }
    });
    // GET /api/installations - list VM install contexts joined with application metadata
    this.app.get(ApiUri.Installations, async (req, res) => {
      try {
        const veContextKey = String(req.params.veContext || "").trim();
        if (!veContextKey) {
          res.status(400).json({ error: "Missing veContext" });
          return;
        }
        const veContext = this.storageContext.getVEContextByKey(veContextKey);
        if (!veContext) {
          res.status(404).json({ error: "VE context not found" });
          return;
        }

        const candidateScriptPaths = [
          path.join(
            this.storageContext.getLocalPath(),
            "shared",
            "scripts",
            "list-managed-oci-containers.py",
          ),
          path.join(
            this.storageContext.getJsonPath(),
            "shared",
            "scripts",
            "list-managed-oci-containers.py",
          ),
        ];
        const scriptPath = candidateScriptPaths.find((p) => {
          try {
            return fs.existsSync(p) && fs.statSync(p).isFile();
          } catch {
            return false;
          }
        });
        if (!scriptPath) {
          res.status(500).json({
            error:
              "list-managed-oci-containers.py not found (expected in local/shared/scripts or json/shared/scripts)",
          });
          return;
        }

        const cmd: ICommand = {
          name: "List Managed OCI Containers",
          execute_on: "ve",
          script: scriptPath,
          outputs: ["containers"],
        };

        const ve = new VeExecution(
          [cmd],
          [],
          veContext,
          new Map(),
          undefined,
          determineExecutionMode(),
        );
        await ve.run(null);
        const containersRaw = ve.outputs.get("containers");
        const parsed =
          typeof containersRaw === "string" && containersRaw.trim().length > 0
            ? JSON.parse(containersRaw)
            : [];
        const payload: IInstallationsResponse = Array.isArray(parsed) ? parsed : [];
        res.status(200).json(payload);
      } catch (err: any) {
        const serializedError = this.serializeError(err);
        res.status(500).json({
          error: err instanceof Error ? err.message : String(err),
          serializedError: serializedError,
        });
      }
    });
    this.app.get(ApiUri.TemplateDetailsForApplication, async (req, res) => {
      try {
        const veContext = storageContext.getVEContextByKey(
          req.params.veContext,
        );
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
        this.returnResponse<ITemplateProcessorLoadResult>(res, application);
      } catch (err: any) {
        res.status(500).json({ error: err.message });
      }
    });

    // GET /api/framework-names - List all frameworks with their IDs and names
    this.app.get(ApiUri.FrameworkNames, (req, res) => {
      try {
        const frameworkNames: Array<{ id: string; name: string }> = [];
        const pm = PersistenceManager.getInstance();
        const allFrameworks = pm.getFrameworkService().getAllFrameworkNames();
        
        for (const [frameworkId] of allFrameworks) {
          try {
            const framework = pm.getFrameworkService().readFramework(
              frameworkId,
              {
                error: new VEConfigurationError("", frameworkId),
              },
            );
            frameworkNames.push({
              id: frameworkId,
              name: framework.name || frameworkId,
            });
          } catch {
            // Skip invalid frameworks
          }
        }
        
        this.returnResponse<IFrameworkNamesResponse>(res, {
          frameworks: frameworkNames,
        });
      } catch (err: any) {
        const statusCode = this.getErrorStatusCode(err);
        const serializedError = this.serializeError(err);
        res.status(statusCode).json({
          error: err instanceof Error ? err.message : String(err),
          serializedError: serializedError,
        });
      }
    });

    // GET /api/framework-parameters/:frameworkId - Get all parameters for a framework
    this.app.get(ApiUri.FrameworkParameters, async (req, res) => {
      try {
        const frameworkId: string = req.params.frameworkId;
        if (!frameworkId) {
          return res.status(400).json({ error: "Missing frameworkId" });
        }

        const veContext = storageContext.getCurrentVEContext();
        if (!veContext) {
          return res
            .status(404)
            .json({ error: "No VE context available. Please configure SSH first." });
        }

        const pm = PersistenceManager.getInstance();
        const frameworkLoader = new FrameworkLoader(
          {
            schemaPath: storageContext.getJsonPath().replace(/\/json$/, "/schemas"),
            jsonPath: storageContext.getJsonPath(),
            localPath: storageContext.getLocalPath(),
          },
          storageContext,
          pm.getPersistence(),
        );

        const parameters = await frameworkLoader.getParameters(
          frameworkId,
          "installation",
          veContext,
        );

        this.returnResponse<IFrameworkParametersResponse>(res, {
          parameters,
        });
      } catch (err: any) {
        const statusCode = this.getErrorStatusCode(err);
        const serializedError = this.serializeError(err);
        res.status(statusCode).json({
          error: err instanceof Error ? err.message : String(err),
          serializedError: serializedError,
        });
      }
    });

    // POST /api/framework-create-application - Create a new application from a framework
    this.app.post(
      ApiUri.FrameworkCreateApplication,
      express.json(),
      async (req, res) => {
        try {
          const body = req.body as IPostFrameworkCreateApplicationBody;
          
          if (!body.frameworkId) {
            return res.status(400).json({ error: "Missing frameworkId" });
          }
          if (!body.applicationId) {
            return res.status(400).json({ error: "Missing applicationId" });
          }
          if (!body.name) {
            return res.status(400).json({ error: "Missing name" });
          }
          if (!body.description) {
            return res.status(400).json({ error: "Missing description" });
          }

          const pm = PersistenceManager.getInstance();
          const frameworkLoader = new FrameworkLoader(
            {
              schemaPath: pm.getPathes().schemaPath,
              jsonPath: pm.getPathes().jsonPath,
              localPath: pm.getPathes().localPath,
            },
            storageContext,
            pm.getPersistence(),
          );

          const applicationId = await frameworkLoader.createApplicationFromFramework(
            body,
          );
          
          this.returnResponse<IPostFrameworkCreateApplicationResponse>(res, {
            success: true,
            applicationId: applicationId,
          });
        } catch (err: any) {
          const statusCode = this.getErrorStatusCode(err);
          const serializedError = this.serializeError(err);
          res.status(statusCode).json({
            error: err instanceof Error ? err.message : String(err),
            serializedError: serializedError,
          });
        }
      },
    );

    // POST /api/framework-from-image - Get framework metadata from OCI image annotations
    this.app.post(
      "/api/framework-from-image",
      express.json(),
      async (req, res) => {
        try {
          const body = req.body as IPostFrameworkFromImageBody;
          
          if (!body.image) {
            return res.status(400).json({ error: "Missing image" });
          }
          
          const tag = body.tag || "latest";
          const veContext = storageContext.getCurrentVEContext();
          
          if (!veContext) {
            return res.status(400).json({ error: "No VE context configured. Please configure SSH connection first." });
          }
          
          // Get annotations from OCI image
          // The script automatically checks if image exists first (fast --raw check),
          // then performs full inspection if the image exists
          let annotations: IOciImageAnnotations;
          try {
            annotations = await FrameworkFromImage.getAnnotationsFromImage(
              veContext,
              body.image,
              tag,
            );
          } catch (err: any) {
            // Check if error is "image not found"
            const errorMessage = err instanceof Error ? err.message : String(err);
            if (errorMessage.includes("not found") || errorMessage.includes("Image")) {
              return res.status(404).json({ 
                error: `Image ${body.image}:${tag} not found` 
              });
            }
            // Re-throw other errors
            throw err;
          }
          
          // Build application defaults from annotations
          const defaults = FrameworkFromImage.buildApplicationDefaultsFromAnnotations(
            body.image,
            annotations,
          );
          
          this.returnResponse<IPostFrameworkFromImageResponse>(res, {
            annotations,
            defaults,
          });
        } catch (err: any) {
          const statusCode = this.getErrorStatusCode(err);
          const serializedError = this.serializeError(err);
          res.status(statusCode).json({
            error: err instanceof Error ? err.message : String(err),
            serializedError: serializedError,
          });
        }
      },
    );

    const webAppVE = new WebAppVE(this.app);
    webAppVE.init();

    // Catch-all route for Angular routing - must be after all API routes
    // This ensures that routes like /ssh-config work correctly.
    // Use a RegExp instead of "*" to avoid path-to-regexp errors on Express 5.
    if (staticDir) {
      this.app.get(/^(?!\/api\/).*/, (req, res) => {
        // All non-API GET requests are served by Angular index.html
        res.sendFile(path.join(staticDir, "index.html"));
      });
    }
  }
}
