#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import { DocumentationPathResolver } from "./documentation-path-resolver.mjs";
import { TemplateAnalyzer } from "./template-analyzer.mjs";
import type { IProcessedTemplate } from "./templateprocessor.mjs";
import type { IParameter, ITemplate } from "./types.mjs";
import type { ITemplate as ITemplateFromBackend } from "./backend-types.mjs";

/**
 * Generates Markdown documentation for templates.
 */
export class TemplateDocumentGenerator {
  private pathResolver: DocumentationPathResolver;
  private templateAnalyzer: TemplateAnalyzer;

  constructor(
    pathResolver: DocumentationPathResolver,
    templateAnalyzer: TemplateAnalyzer,
  ) {
    this.pathResolver = pathResolver;
    this.templateAnalyzer = templateAnalyzer;
  }

  /**
   * Generates template documentation content.
   */
  async generateDoc(
    templateName: string,
    templateData: ITemplate,
    applicationName: string,
    isShared: boolean,
    appPath: string,
    templateInfo?: IProcessedTemplate,
  ): Promise<string> {
    const lines: string[] = [];

    // Title
    lines.push(`# ${templateData.name || templateName}`);
    lines.push("");

    // Description
    if (templateData.description) {
      lines.push(templateData.description);
      lines.push("");
    }

    // Execution Target
    if (templateData.execute_on) {
      lines.push(`**Execution Target:** ${templateData.execute_on}`);
      lines.push("");
    }

    // Capabilities (extracted from script headers and template commands) - BEFORE Parameters
    lines.push("## Capabilities");
    lines.push("");
    lines.push("This template provides the following capabilities:");
    lines.push("");
    
    // Use capabilities from templateInfo if available, otherwise extract manually
    let capabilities: string[] = [];
    if (templateInfo?.capabilities && templateInfo.capabilities.length > 0) {
      capabilities = templateInfo.capabilities;
    } else {
      // Fallback: extract capabilities manually
      capabilities = this.extractCapabilities(templateData, templateName, appPath);
    }
    
    if (capabilities.length > 0) {
      for (const capability of capabilities) {
        lines.push(`- ${capability}`);
      }
    } else {
      lines.push("- See template implementation for details");
    }
    lines.push("");

    // Used By Applications (usage examples)
    // Use usedByApplications from templateInfo if available, otherwise find manually
    let usingApplications: string[] = [];
    if (templateInfo?.usedByApplications && templateInfo.usedByApplications.length > 0) {
      usingApplications = templateInfo.usedByApplications;
    } else {
      // Fallback: find applications manually
      usingApplications = await this.templateAnalyzer.findApplicationsUsingTemplate(templateName);
    }
    
    if (usingApplications.length > 0) {
      lines.push("## Used By Applications");
      lines.push("");
      lines.push("This template is used by the following applications (usage examples):");
      lines.push("");
      for (const appName of usingApplications) {
        // Templates are in html/json/shared/templates/ or html/json/applications/<app>/templates/
        // Applications are in html/, so we need ../../../ to go up three levels for shared templates
        // For application-specific templates, we need ../../../../ to go up four levels
        const linkPath = isShared ? `../../../${appName}.md` : `../../../../${appName}.md`;
        lines.push(`- [${appName}](${linkPath})`);
      }
      lines.push("");
    }

    // Generated Parameters Section
    if (templateData.parameters && templateData.parameters.length > 0) {
      lines.push("<!-- GENERATED_START:PARAMETERS -->");
      lines.push("## Parameters");
      lines.push("");
      lines.push(this.generateParametersTable(templateData.parameters));
      lines.push("");
      lines.push("<!-- GENERATED_END:PARAMETERS -->");
      lines.push("");
    }

    // Generated Outputs Section
    if (templateData.outputs && templateData.outputs.length > 0) {
      lines.push("<!-- GENERATED_START:OUTPUTS -->");
      lines.push("## Outputs");
      lines.push("");
      lines.push("| Output ID | Default | Description |");
      lines.push("|-----------|---------|-------------|");
      for (const output of templateData.outputs) {
        const defaultVal = output.default !== undefined
          ? String(output.default)
          : "-";
        lines.push(`| \`${output.id}\` | ${defaultVal} | - |`);
      }
      lines.push("");
      lines.push("<!-- GENERATED_END:OUTPUTS -->");
      lines.push("");
    }

    // Commands
    if (templateData.commands && templateData.commands.length > 0) {
      // Check if there's only one command with properties (common case)
      const firstCmd = templateData.commands[0];
      const hasOnlyPropertiesCommand = templateData.commands.length === 1 && 
        firstCmd &&
        firstCmd.properties &&
        !firstCmd.script &&
        !firstCmd.command &&
        !firstCmd.template;
      
      if (hasOnlyPropertiesCommand && firstCmd) {
        // Special case: Only properties command - show as a properties table
        lines.push("<!-- GENERATED_START:COMMANDS -->");
        lines.push("## Properties");
        lines.push("");
        lines.push("This template sets the following properties:");
        lines.push("");
        lines.push("| Property ID | Value |");
        lines.push("|-------------|-------|");
        
        const props = Array.isArray(firstCmd.properties) ? firstCmd.properties : [firstCmd.properties];
        
        // Filter out properties that are only template variables matching parameters
        const filteredProps = props.filter((p: any) => {
          if (typeof p !== "object" || p === null || !p.id) {
            return true; // Keep non-object properties
          }
          
          // Skip if value is only a template variable that matches a parameter
          if (p.value !== undefined && this.isPropertyOnlyTemplateVariable(p.value, templateData.parameters || [])) {
            return false;
          }
          
          return true;
        });
        
        for (const p of filteredProps) {
          if (typeof p === "object" && p !== null && p.id) {
            let valueStr = "";
            if (p.value !== undefined) {
              // Format value for display
              if (typeof p.value === "string") {
                // Replace newlines with <br> for multi-line values
                valueStr = p.value.replace(/\n/g, "<br>");
                // Escape pipe characters
                valueStr = valueStr.replace(/\|/g, "&#124;");
              } else {
                valueStr = String(p.value);
              }
            } else {
              valueStr = "-";
            }
            lines.push(`| \`${p.id}\` | ${valueStr} |`);
          }
        }
        lines.push("");
        lines.push("<!-- GENERATED_END:COMMANDS -->");
        lines.push("");
      } else {
        // Normal case: Multiple commands or non-properties commands
        lines.push("<!-- GENERATED_START:COMMANDS -->");
        lines.push("## Commands");
        lines.push("");
        lines.push("This template executes the following commands in order:");
        lines.push("");
        lines.push("| # | Command | Type | Details | Description |");
        lines.push("|---|---------|------|---------|-------------|");
        
        for (let i = 0; i < templateData.commands.length; i++) {
          const cmd = templateData.commands[i];
          if (!cmd) continue;
          
          const commandName = cmd.name || "Unnamed Command";
          let commandType = "";
          let commandDetails = "";
          
          if (cmd.script) {
            commandType = "Script";
            // Use resolved script path from templateInfo if available
            let scriptDisplay = cmd.script;
            if (templateInfo?.resolvedScriptPaths?.has(cmd.script)) {
              const resolvedPath = templateInfo.resolvedScriptPaths.get(cmd.script)!;
              // Show just the script name, not the full path
              scriptDisplay = path.basename(resolvedPath);
            }
            commandDetails = `\`${scriptDisplay}\``;
            if (cmd.library) {
              commandDetails += ` (library: \`${cmd.library}\`)`;
            }
          } else if (cmd.command) {
            commandType = "Command";
            // Truncate long commands for table display
            const cmdPreview = cmd.command.length > 50 
              ? cmd.command.substring(0, 47) + "..."
              : cmd.command;
            commandDetails = `\`${cmdPreview}\``;
          } else if (cmd.template) {
            commandType = "Template";
            const templateDocName = this.pathResolver.getTemplateDocName(cmd.template);
            commandDetails = `[${cmd.template}](templates/${templateDocName})`;
          } else if (cmd.properties) {
            commandType = "Properties";
            const props = Array.isArray(cmd.properties) ? cmd.properties : [cmd.properties];
            const propList = props.map((p: any) => {
              if (typeof p === "object" && p !== null && p.id) {
                let valueStr = "";
                if (p.value !== undefined) {
                  if (typeof p.value === "string" && p.value.length > 30) {
                    valueStr = p.value.substring(0, 27) + "...";
                  } else {
                    valueStr = String(p.value);
                  }
                } else {
                  valueStr = "-";
                }
                return `\`${p.id}\` = \`${valueStr}\``;
              }
              return String(p);
            }).join(", ");
            commandDetails = propList.length > 80 ? propList.substring(0, 77) + "..." : propList;
          } else {
            commandType = "Unknown";
            commandDetails = "-";
          }
          
          let description = cmd.description || "-";
          // Format description for markdown table
          description = description.replace(/\n/g, " ");
          description = description.replace(/\|/g, "&#124;");
          if (description.length > 100) {
            description = description.substring(0, 97) + "...";
          }
          lines.push(`| ${i + 1} | ${commandName} | ${commandType} | ${commandDetails} | ${description} |`);
        }
        lines.push("");
        lines.push("<!-- GENERATED_END:COMMANDS -->");
        lines.push("");
      }
    }

    return lines.join("\n");
  }

  /**
   * Generates a markdown table for parameters.
   */
  private generateParametersTable(parameters: IParameter[]): string {
    const lines: string[] = [];
    lines.push("| Parameter | Type | Required | Default | Description |");
    lines.push("|-----------|------|----------|---------|-------------|");

    for (const param of parameters) {
      const type = param.type || "string";
      const required = param.required ? "Yes" : "No";
      const defaultVal = param.default !== undefined
        ? String(param.default)
        : "-";
      const description = param.description || "";

      // Add flags
      const flags: string[] = [];
      if (param.secure) flags.push("🔒 Secure");
      if (param.advanced) flags.push("⚙️ Advanced");
      if (param.upload) flags.push("📤 Upload");
      const flagsStr = flags.length > 0 ? ` ${flags.join(" ")}` : "";

      lines.push(
        `| \`${param.id}\` | ${type} | ${required} | ${defaultVal} | ${description}${flagsStr} |`,
      );
    }

    return lines.join("\n");
  }

  /**
   * Extracts capabilities from script headers and template commands.
   */
  private extractCapabilities(
    templateData: ITemplate,
    templateName: string,
    appPath: string,
  ): string[] {
    const capabilities: string[] = [];

    if (!templateData.commands) {
      return capabilities;
    }

    for (const cmd of templateData.commands) {
      if (!cmd) continue;
      
      // Check for script execution - read script header for capabilities
      if (cmd.script) {
        const scriptCapabilities = this.extractCapabilitiesFromScriptHeader(
          cmd.script,
          appPath,
        );
        if (scriptCapabilities.length > 0) {
          capabilities.push(...scriptCapabilities);
        } else {
          // Fallback: Try to infer capability from script name
          const scriptName = cmd.script;
          if (scriptName.includes("configure")) {
            capabilities.push("Configuration management");
          } else if (scriptName.includes("install")) {
            capabilities.push("Package installation");
          } else if (scriptName.includes("start") || scriptName.includes("enable")) {
            capabilities.push("Service management");
          } else if (scriptName.includes("create")) {
            capabilities.push("Resource creation");
          } else if (scriptName.includes("setup")) {
            capabilities.push("System setup");
          }
        }
      }

      // Check for command execution
      if (cmd.command) {
        capabilities.push(`Executes command: \`${cmd.command}\``);
      }

      // Check for template reference
      if (cmd.template) {
        capabilities.push(`References template: \`${cmd.template}\``);
      }

      // Check for properties (parameter setting)
      if (cmd.properties) {
        const props = Array.isArray(cmd.properties)
          ? cmd.properties
          : Object.entries(cmd.properties).map(([id, value]) => ({ id, value }));
        
        // Analyze properties to determine capabilities
        const propIds = props.map((p: any) => p.id || Object.keys(p)[0]).join(" ").toLowerCase();
        
        if (propIds.includes("username") || propIds.includes("user")) {
          capabilities.push("User management");
        }
        if (propIds.includes("package") || propIds.includes("packages")) {
          capabilities.push("Package configuration");
        }
        if (propIds.includes("volume") || propIds.includes("volumes")) {
          capabilities.push("Volume management");
        }
        if (propIds.includes("command") && propIds.includes("command_args")) {
          capabilities.push("Service configuration");
        }
        if (propIds.includes("port") || propIds.includes("bind")) {
          capabilities.push("Network configuration");
        }
      }
    }

    // Remove duplicates
    return [...new Set(capabilities)];
  }

  /**
   * Extracts capabilities from script header comments.
   */
  private extractCapabilitiesFromScriptHeader(
    scriptName: string,
    appPath: string,
  ): string[] {
    const capabilities: string[] = [];
    
    const scriptPath = this.pathResolver.resolveScriptPath(scriptName, appPath);
    if (!scriptPath) {
      return capabilities;
    }
    
    try {
      const scriptContent = fs.readFileSync(scriptPath, "utf-8");
      const lines = scriptContent.split("\n");
      
      // Look for "This script" section in header comments
      let inHeader = false;
      let foundThisScript = false;
      
      for (let i = 0; i < lines.length && i < 50; i++) {
        const line = lines[i]?.trim() || "";
        
        // Start of header (after shebang)
        if (line.startsWith("#") && !line.startsWith("#!/")) {
          inHeader = true;
        }
        
        // Look for "This script" or "This library" line
        if (inHeader && (line.includes("This script") || line.includes("This library"))) {
          foundThisScript = true;
        }
        
        // Look for numbered list of capabilities (e.g., "# 1. Validates...", "2. Creates...")
        if (foundThisScript && inHeader) {
          // Match lines like "# 1. Validates..." or "1. Validates..."
          const numberedMatch = line.match(/^#*\s*\d+\.\s+(.+)/);
          if (numberedMatch && numberedMatch[1]) {
            let capability = numberedMatch[1].trim();
            // Remove leading # if present
            capability = capability.replace(/^#+\s*/, "").trim();
            if (capability.length > 0) {
              capabilities.push(capability);
            }
          }
        }
        
        // Stop at first non-comment line after header
        if (inHeader && !line.startsWith("#") && line.length > 0 && !line.startsWith("exec >&2")) {
          break;
        }
      }
    } catch {
      // Ignore errors reading script
    }
    
    return capabilities;
  }

  /**
   * Extracts template variables from a string (e.g., "{{ var }}").
   */
  private extractTemplateVariables(str: string): string[] {
    const regex = /{{ *([^}\ ]+) *}}/g;
    const vars = new Set<string>();
    let match;
    while ((match = regex.exec(str)) !== null) {
      if (match[1]) {
        vars.add(match[1]);
      }
    }
    return Array.from(vars);
  }

  /**
   * Checks if a property value is only a template variable that matches a parameter.
   */
  private isPropertyOnlyTemplateVariable(
    value: string | number | boolean,
    templateParameters: IParameter[],
  ): boolean {
    if (typeof value !== "string") {
      return false;
    }
    
    // Check if the value is exactly a template variable (e.g., "{{ param_name }}" or "{{param_name}}")
    const trimmed = value.trim();
    const vars = this.extractTemplateVariables(trimmed);
    
    // If there's exactly one variable, check if the entire value is just that variable
    if (vars.length === 1) {
      const varName = vars[0];
      
      // Normalize the value: remove all whitespace
      const normalizedValue = trimmed.replace(/\s+/g, "");
      const expectedPattern = `{{${varName}}}`;
      
      // Check if the normalized value matches exactly the template variable pattern
      if (normalizedValue === expectedPattern) {
        // Check if this variable is already defined as a parameter
        return templateParameters.some((p) => p.id === varName);
      }
    }
    
    return false;
  }
}

