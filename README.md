# LXC Manager

LXC Manager provides a simple way to install and manage LXC containers (currently Proxmox VE) using reusable JSON templates and a Web UI.

- All text files in this project are in English.
- Angular templates: use `@for` instead of `*ngFor` and `@if` instead of `*ngIf`.
- JSON Schemas are located under `backend/schemas/`.
- Main executables:
  - `backend/dist/lxc-exec.mjs`: CLI to execute tasks like `installation`, `backup`, etc.
  - `backend/dist/webapp.mjs`: Same engine with a Web UI to select an application and run a task.

## Installation Scenario
Install LXC Manager as an LXC container on a VE host (currently Proxmox only).

## Use Scenarios
- Open the Web UI and install commonly available applications (e.g., Home Assistant, Node-RED).
- Create your own extended applications and templates with easier setup (e.g., static IP generation).

## Applications
Applications have the same purpose:
- Make LXC container installation easy.
- Make configuration easy by using extended applications and local templates/scripts.
- Allow custom applications in `backend/local/`.
- Provide templates for optional features like disk sharing, USB serial mapping, IP address management.
- Extended applications can build upon shared templates.

## Project Structure Highlights
- `backend/schemas/`: JSON Schemas (template, application, outputs, etc.).
- `backend/json/`: Shared templates and applications.
- `backend/local/`: Your local parameters, templates, and runtime JSON (not packaged).
- `frontend/`: Angular Web UI (build output typically under `frontend/dist/...`).

## Quick Start
1) Build backend and frontend:
```zsh
cd backend && npm run build
cd ../frontend && npm run build
```

2) Run Web UI locally:
```zsh
cd ..
node bin/webapp --local ./backend/local
# Open http://localhost:3000
```

3) Run a CLI task (installation example):
```zsh
cd backend
node dist/lxc-exec.mjs <application-id> installation "local/parameters.json" "local/restart-info.json"
```

- `<application-id>` refers to a folder under `backend/json/applications/` (e.g., `macbckpsrv`, `modbus2mqtt`).
- `local/parameters.json` holds environment-specific values; `local/restart-info.json` is used for resuming/metadata.

## Templates & Features
- Network helpers (e.g., static IP generation and application in separate steps).
- Disk sharing and USB serial mapping templates.
- Parameterized tasks via JSON; resolved against the schemas in `backend/schemas/`.

## Notes
- Proxmox execution: many templates run on the Proxmox host (`execute_on: proxmox`). Ensure proper permissions, bridges, and storage availability.
- For Angular static serving, the frontend build path can be configured via `LXC_MANAGER_FRONTEND_DIR` or `package.json` (`lxcManager.frontendDir`).

## E2E Testing (optional)
Playwright is set up to run end-to-end tests against the built app:
```zsh
npm i
npx playwright install
npm run e2e
```

## License
Internal project. Add license information if needed.# LXC Manager

LXC Manager is a tool designed to simplify the creation and configuration of LXC containers on Proxmox hosts.

## Overview

- **Purpose:**
  - Automates the provisioning and configuration of LXC containers on Proxmox.
  - Provides a library of reusable scripts and application templates for common container setups.
  - Enables users to easily extend and customize container deployments.

- **Features:**
  - Step-by-step automation for container creation, disk mapping, user management, and service installation.
  - Modular design: templates and scripts can be reused and combined for different applications.
  - Supports local overrides and extensions for custom requirements.

- **Contribution:**
  - The project aims to grow its collection of templates and ready-to-use applications.
  - Contributions of new templates, scripts, and application examples are very welcome!

---


For configuration details, see [docs/configuration.md](docs/configuration.md).
For more details, see the documentation in the `docs/` folder and example configurations in `json/applications` and `json/shared`.
