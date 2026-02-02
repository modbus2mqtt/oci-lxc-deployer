import { IApplication } from "../backend-types.mjs";
import { IAddon, IAddonWithParameters, AddonTemplateReference, IParameter } from "../types.mjs";
import { IAddonPersistence, ITemplatePersistence } from "../persistence/interfaces.mjs";

/**
 * Service layer for addon operations
 * Provides business logic for addon compatibility and template merging
 */
export class AddonService {
  constructor(
    private persistence: IAddonPersistence,
    private templatePersistence?: ITemplatePersistence,
  ) {}

  /**
   * Returns all addon IDs
   */
  getAddonIds(): string[] {
    return this.persistence.getAddonIds();
  }

  /**
   * Loads an addon by ID
   */
  getAddon(addonId: string): IAddon {
    return this.persistence.loadAddon(addonId);
  }

  /**
   * Returns all addons
   */
  getAllAddons(): IAddon[] {
    return this.persistence.getAllAddons();
  }

  /**
   * Returns addons compatible with the given application
   */
  getCompatibleAddons(application: IApplication): IAddon[] {
    return this.getAllAddons().filter((addon) =>
      this.isAddonCompatible(addon, application),
    );
  }

  /**
   * Returns addons compatible with the given application, including extracted parameters
   */
  getCompatibleAddonsWithParameters(application: IApplication): IAddonWithParameters[] {
    const compatibleAddons = this.getCompatibleAddons(application);
    return compatibleAddons.map((addon) => this.extractAddonParameters(addon));
  }

  /**
   * Gets parameters for an addon.
   * Prefers parameters defined directly in addon JSON over extracting from templates.
   */
  extractAddonParameters(addon: IAddon): IAddonWithParameters {
    // If addon has parameters defined directly, use those (new approach)
    if (addon.parameters && addon.parameters.length > 0) {
      return addon as IAddonWithParameters;
    }

    // Fallback: extract parameters from addon templates (legacy approach)
    if (!this.templatePersistence) {
      return addon;
    }

    const allTemplateRefs: AddonTemplateReference[] = [
      ...(addon.pre_start ?? []),
      ...(addon.post_start ?? []),
      ...(addon.upgrade ?? []),
    ];

    const parameters: IParameter[] = [];
    const seenParamIds = new Set<string>();

    for (const templateRef of allTemplateRefs) {
      const templateName = this.getTemplateName(templateRef);
      const extractedParams = this.extractParametersFromTemplate(templateName);

      for (const param of extractedParams) {
        // Avoid duplicate parameters
        if (!seenParamIds.has(param.id)) {
          seenParamIds.add(param.id);
          parameters.push(param);
        }
      }
    }

    if (parameters.length === 0) {
      return addon;
    }

    return {
      ...addon,
      parameters,
    };
  }

  /**
   * Extracts parameters from a single template by name
   */
  private extractParametersFromTemplate(templateName: string): IParameter[] {
    if (!this.templatePersistence) {
      return [];
    }

    try {
      // Addon templates are typically shared templates
      const templatePath = this.templatePersistence.resolveTemplatePath(templateName, true);
      if (!templatePath) {
        return [];
      }

      const template = this.templatePersistence.loadTemplate(templatePath);
      if (!template || !template.parameters) {
        return [];
      }

      return template.parameters;
    } catch {
      // Template not found or invalid
      return [];
    }
  }

  /**
   * Checks if an addon is compatible with an application
   *
   * Compatibility rules:
   * - "*" matches all applications
   * - Application ID matches directly
   * - Application's extends chain matches
   * - "tag:<tag-id>" matches application tags
   */
  isAddonCompatible(addon: IAddon, application: IApplication): boolean {
    // Wildcard matches all
    if (addon.compatible_with === "*") {
      return true;
    }

    for (const criterion of addon.compatible_with) {
      // Tag-based matching
      if (criterion.startsWith("tag:")) {
        const tag = criterion.substring(4);
        if (application.tags?.includes(tag)) {
          return true;
        }
      }
      // Direct application ID or extends chain matching
      else {
        if (application.id === criterion) {
          return true;
        }
        if (application.extends === criterion) {
          return true;
        }
      }
    }

    return false;
  }

  /**
   * Merges addon templates into base templates
   *
   * @param baseTemplates The application's base template list
   * @param addon The addon to merge
   * @param phase Which phase templates to merge (pre_start, post_start, upgrade)
   * @returns New template list with addon templates inserted
   */
  mergeAddonTemplates(
    baseTemplates: AddonTemplateReference[],
    addon: IAddon,
    phase: "pre_start" | "post_start" | "upgrade",
  ): AddonTemplateReference[] {
    const addonTemplates = addon[phase];
    if (!addonTemplates || addonTemplates.length === 0) {
      return baseTemplates;
    }

    const result = [...baseTemplates];

    for (const template of addonTemplates) {
      this.insertTemplate(result, template);
    }

    return result;
  }

  /**
   * Inserts a template at the correct position based on before/after references
   */
  private insertTemplate(
    templates: AddonTemplateReference[],
    template: AddonTemplateReference,
  ): void {
    // If it's just a string, append to end
    if (typeof template === "string") {
      templates.push(template);
      return;
    }

    // Handle before reference
    if (template.before) {
      const idx = this.findTemplateIndex(templates, template.before);
      if (idx >= 0) {
        templates.splice(idx, 0, template.name);
        return;
      }
    }

    // Handle after reference
    if (template.after) {
      const idx = this.findTemplateIndex(templates, template.after);
      if (idx >= 0) {
        templates.splice(idx + 1, 0, template.name);
        return;
      }
    }

    // Default: append to end
    templates.push(typeof template === "string" ? template : template.name);
  }

  /**
   * Finds the index of a template by name in the template list
   */
  private findTemplateIndex(
    templates: AddonTemplateReference[],
    targetName: string,
  ): number {
    return templates.findIndex((t) => {
      const name = typeof t === "string" ? t : t.name;
      return name === targetName;
    });
  }

  /**
   * Extracts template name from a reference
   */
  getTemplateName(template: AddonTemplateReference): string {
    return typeof template === "string" ? template : template.name;
  }
}
