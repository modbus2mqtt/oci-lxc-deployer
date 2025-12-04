#!/usr/bin/env node
import express from "express";
import { TaskType, ISsh, ApiUri } from "@src/types.mjs";
import http from "http";
import path from "path";
import { fileURLToPath } from "node:url";
import fs from "fs";
import { StorageContext } from "./storagecontext.mjs";
import { IVEContext } from "./backend-types.mjs";
export class VEWebApp {
  app: express.Application;
  public httpServer: http.Server;

  constructor(storageContext: StorageContext) {
    this.app = express();
    this.httpServer = http.createServer(this.app);
    // No socket.io needed anymore

    // Serve Angular static files (built frontend)
    const __filename = fileURLToPath(import.meta.url);
    const __dirname = path.dirname(__filename);
    // fs imported from ESM above
    // Allow configuration via ENV or package.json
    // ENV has precedence: absolute or relative to repo root
    let configuredRel: string | undefined = process.env.LXC_MANAGER_FRONTEND_DIR;
    try {
      const rootPkg = path.join(__dirname, "../../package.json");
      if (fs.existsSync(rootPkg)) {
        const pkg = JSON.parse(fs.readFileSync(rootPkg, "utf-8"));
        if (pkg && pkg.lxcManager && pkg.lxcManager.frontendDir && !configuredRel) {
          configuredRel = String(pkg.lxcManager.frontendDir);
        }
      }
    } catch {}

    const repoRoot = path.join(__dirname, "../../");
    const candidates: string[] = [];
    if (configuredRel) {
      // support absolute or relative path
      candidates.push(path.isAbsolute(configuredRel) ? configuredRel : path.join(repoRoot, configuredRel));
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
        const sshs: ISsh[] = storageContext
          .keys()
          .filter((key) => key.startsWith("ve_"))
          .map((key) => {
            return storageContext.get<IVEContext>(key) as any;
          });
        res.json(sshs);
      } catch (err: any) {
        res.status(500).json({ error: err.message });
      }
    });

    this.app.post(ApiUri.SshConfig, express.json(), (req, res) => {
      const ssh: ISsh = req.body;
      if (
        !ssh ||
        typeof ssh.host !== "string" ||
        typeof ssh.port !== "number"
      ) {
        res.status(400).json({
          error:
            "Invalid SSH config. Must provide host (string) and port (number).",
        });
        return;
      }
      try {
        storageContext.setVEContext({
          host: ssh.host,
          port: ssh.port,
          current: ssh.current || false
        } as IVEContext);
        res.json({ success: true }).status(200);
      } catch (err: any) {
        res.status(500).json({ error: err.message });
      }
    });

    this.app.get(
      "/api/getUnresolvedParameters/:application/:task",
      (req, res) => {
        const { application, task } = req.params;
        try {
          const templateProcessor = storageContext.getTemplateProcessor();
          const loaded = templateProcessor.loadApplication(
            application,
            task as TaskType,
          );
          const unresolvedParameters =
            templateProcessor.getUnresolvedParameters(
              loaded.parameters,
              loaded.resolvedParams,
            );
          res
            .json({
              unresolvedParameters: unresolvedParameters,
            })
            .status(200);
        } catch (err: any) {
          res
            .status(400)
            .json({ error: err.message, errors: err.errors || [] });
        }
      },
    );

    this.app.get("/api/applications", (req, res) => {
      try {
        const applications = storageContext.listApplications();

        res.json(applications).status(200);
      } catch (err: any) {
        res.status(500).json({ error: err.message });
      }
    });
  }
}

// If run directly, start the server
if (
  import.meta.url === process.argv[1] ||
  import.meta.url === `file://${process.argv[1]}`
) {
  const filename = fileURLToPath(import.meta.url);
  const dirname = path.dirname(filename);
  // Do NOT change working directory; respect caller's CWD.
  // Support --local <dir> CLI option to set the local directory
  // Default is './local' relative to current working directory
  const argv = process.argv.slice(2);
  let localDir: string | undefined;
  const localIdx = argv.indexOf("--local");
  if (localIdx !== -1) {
    const candidateArg = argv[localIdx + 1] || "";
    const candidate = String(candidateArg);
    if (candidate.length > 0) {
      localDir = path.isAbsolute(candidate)
        ? candidate
        : path.join(process.cwd(), candidate);
    }
  }
  if (!localDir) {
    localDir = path.join(process.cwd(), "local");
  }
  const backendRoot = path.join(dirname, "..");
  const sharedJsonPath = path.join(backendRoot, "json");
  const schemaPath = path.join(backendRoot, "schemas");
  const jsonTestPath = path.join(localDir, "json");
  // Initialize StorageContext with absolute paths to avoid CWD-dependency
  (StorageContext as any).instance = new StorageContext(
    jsonTestPath,
    sharedJsonPath,
    schemaPath,
  );
  const webApp = new VEWebApp(StorageContext.getInstance());
  const port = process.env.PORT || 3000;
  webApp.httpServer.listen(port, () => {
    console.log(`ProxmoxWebApp listening on port ${port}`);
  });
}
