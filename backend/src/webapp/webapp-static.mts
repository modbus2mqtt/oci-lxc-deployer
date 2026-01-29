import express from "express";
import path from "path";
import { fileURLToPath } from "node:url";
import fs from "fs";

export function setupStaticRoutes(app: express.Application): string | undefined {
  const __filename = fileURLToPath(import.meta.url);
  const __dirname = path.dirname(__filename);
  let configuredRel: string | undefined = process.env.LXC_MANAGER_FRONTEND_DIR;
  try {
    const rootPkg = path.join(__dirname, "../../package.json");
    if (fs.existsSync(rootPkg)) {
      const pkg = JSON.parse(fs.readFileSync(rootPkg, "utf-8"));
      if (
        pkg &&
        pkg.ociLxcDeployer &&
        pkg.ociLxcDeployer.frontendDir &&
        !configuredRel
      ) {
        configuredRel = String(pkg.ociLxcDeployer.frontendDir);
      }
    }
  } catch {}

  const repoRoot = path.join(__dirname, "../../");
  const candidates: string[] = [];
  if (configuredRel) {
    candidates.push(
      path.isAbsolute(configuredRel)
        ? configuredRel
        : path.join(repoRoot, configuredRel),
    );
  }
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
    app.use(express.static(staticDir));
    app.get("/", (_req, res) => {
      res.sendFile(path.join(staticDir, "index.html"));
    });
  }

  return staticDir;
}
