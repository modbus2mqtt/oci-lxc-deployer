# Configuration Guide

This document explains how to create and manage templates, scripts, and applications for the LXC Manager system. All configuration should normally be done in the `local` folder to keep customizations separate from shared or default files.

## Structure Overview

- **Applications**: Define the installation and configuration steps for a specific use case or container.
- **Templates**: Describe reusable steps (e.g., create user, map disk) and reference scripts.
- **Scripts**: Shell scripts that perform the actual work, referenced by templates.

## File Locations and Lookup Order

When resolving scripts and templates, the system searches in the following order:
1. The application's own directory (e.g., `json/applications/<appname>/scripts` or `json/applications/<appname>/templates`)
2. The shared directory (e.g., `json/shared/scripts` or `json/shared/templates`)

This allows you to override shared logic for a specific application by placing a file with the same name in the application's directory.

## Creating Applications

1. Create a new folder in `local/json/applications/<yourappname>`.
2. Add an `application.json` file describing your application, including the `installation` array listing the templates to execute.
3. Optionally, add a `templates` and/or `scripts` folder for custom logic.

## Creating Templates

1. Templates are JSON files describing a reusable step (e.g., `create-user.json`).
2. Place custom templates in your application's `templates` folder, or use/extend those in `json/shared/templates`.
3. Reference the script to execute and define required parameters and outputs.

## Creating Scripts

1. Scripts are shell scripts (e.g., `create-user.sh`) referenced by templates.
2. Place custom scripts in your application's `scripts` folder, or use/extend those in `json/shared/scripts`.
3. Scripts should use template variables (e.g., `{{ username }}`) for all parameters.


## Extending Applications

You can extend an existing application by creating a new application in the `local` folder and using the `extend` property in your `application.json`. This allows you to override or add installation steps, templates, or scripts without modifying the original application.

When extending, you can control the order of installation steps using the `after` and `before` properties:

- **after**: Insert your step(s) after a specific step from the base application.
- **before**: Insert your step(s) before a specific step from the base application.

Example:

```json
{
	"extend": "base-app",
	"installation": [
		{ "template": "my-custom-step.json", "after": "120-map-disk.json" },
		{ "template": "my-pre-step.json", "before": "100-create-lxc.json" }
	]
}
```

This will insert `my-custom-step.json` after `120-map-disk.json` and `my-pre-step.json` before `100-create-lxc.json` in the installation sequence.

---

For more details, see the example files in the `json/applications` and `json/shared` directories.