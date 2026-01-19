import { ITemplate } from "@src/types.mjs";
import { ITemplateReference } from "../backend-types.mjs";
import {
  type TemplateRef,
  type ScriptRef,
  type MarkdownRef,
  type IRepositories,
} from "../persistence/repositories.mjs";

export class TemplateResolver {
  constructor(private repositories: IRepositories) {}

  extractTemplateName(template: ITemplateReference | string): string {
    return typeof template === "string" ? template : template.name;
  }

  normalizeTemplateName(templateName: string): string {
    return templateName.replace(/\.json$/i, "");
  }

  buildTemplateTracePath(ref: TemplateRef): string {
    const normalized = this.normalizeTemplateName(ref.name);
    const filename = `${normalized}.json`;
    if (ref.scope === "shared") {
      const origin = ref.origin ?? "json";
      return `${origin}/shared/templates/${filename}`;
    }
    const origin = ref.origin ?? "json";
    const appId = ref.applicationId ?? "unknown-app";
    return `${origin}/applications/${appId}/templates/${filename}`;
  }

  resolveTemplate(
    applicationId: string,
    templateName: string,
  ): { template: ITemplate; ref: TemplateRef } | null {
    const ref = this.repositories.resolveTemplateRef(applicationId, templateName);
    if (!ref) return null;
    const template = this.repositories.getTemplate(ref);
    if (!template) return null;
    return { template, ref };
  }

  resolveScriptContent(
    applicationId: string,
    scriptName: string,
  ): { content: string | null; ref: ScriptRef | null } {
    const appRef: ScriptRef = { name: scriptName, scope: "application", applicationId };
    const appContent = this.repositories.getScript(appRef);
    if (appContent !== null) return { content: appContent, ref: appRef };
    const sharedRef: ScriptRef = { name: scriptName, scope: "shared" };
    const sharedContent = this.repositories.getScript(sharedRef);
    return { content: sharedContent, ref: sharedContent !== null ? sharedRef : null };
  }

  resolveScriptPath(ref: ScriptRef | null): string | null {
    if (!ref) return null;
    return this.repositories.resolveScriptPath(ref);
  }

  resolveLibraryContent(
    applicationId: string,
    libraryName: string,
  ): { content: string | null; ref: ScriptRef | null } {
    const appRef: ScriptRef = { name: libraryName, scope: "application", applicationId };
    const appContent = this.repositories.getScript(appRef);
    if (appContent !== null) return { content: appContent, ref: appRef };
    const sharedRef: ScriptRef = { name: libraryName, scope: "shared" };
    const sharedContent = this.repositories.getScript(sharedRef);
    return { content: sharedContent, ref: sharedContent !== null ? sharedRef : null };
  }

  resolveLibraryPath(ref: ScriptRef | null): string | null {
    if (!ref) return null;
    return this.repositories.resolveLibraryPath(ref);
  }

  resolveMarkdownSection(ref: TemplateRef, sectionName: string): string | null {
    if (ref.scope !== "shared" && ref.applicationId === undefined) {
      return null;
    }
    const markdownRef: MarkdownRef = {
      templateName: this.normalizeTemplateName(ref.name),
      scope: ref.scope,
      ...(ref.applicationId !== undefined ? { applicationId: ref.applicationId } : {}),
    };
    return this.repositories.getMarkdownSection(markdownRef, sectionName);
  }
}
