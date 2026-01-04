import fs from "node:fs";
import path from "node:path";

interface TemplateParameter {
  name: string;
  description?: string;
  type?: string;
  required?: boolean;
}

interface TemplateDoc {
  template: string;
  parameters: TemplateParameter[];
}

export class TemplateDocumentGenerator {
  private templatesDir: string;
  public readonly docsDir: string;
  private schemaPath: string;

  constructor(
    templatesDir: string = path.join("json", "shared", "templates"),
    docsDir: string = path.join("docs", "generated"),
    schemaPath: string = path.join("schemas", "shared.application.schema.json"),
  ) {
    this.templatesDir = templatesDir;
    this.docsDir = docsDir;
    this.schemaPath = schemaPath;
  }

  public generate() {
    if (!fs.existsSync(this.docsDir)) {
      fs.mkdirSync(this.docsDir, { recursive: true });
    }
    const schema = JSON.parse(fs.readFileSync(this.schemaPath, "utf-8"));
    const paramDefs = schema?.properties?.parameters?.items?.properties;
    const paramOrder = schema?.properties?.parameters?.items?.required || [];

    const files = fs
      .readdirSync(this.templatesDir)
      .filter((f) => f.endsWith(".json"));
    for (const file of files) {
      const filePath = path.join(this.templatesDir, file);
      const doc = this.generateDocForTemplate(filePath, paramDefs, paramOrder);
      const outPath = path.join(this.docsDir, file.replace(".json", ".md"));
      fs.writeFileSync(outPath, this.renderMarkdown(doc), "utf-8");
    }
  }

  private generateDocForTemplate(
    templatePath: string,
    paramDefs: any,
    paramOrder: string[],
  ): TemplateDoc {
    const template = JSON.parse(fs.readFileSync(templatePath, "utf-8"));
    const params: TemplateParameter[] = [];
    if (Array.isArray(template.parameters)) {
      for (const param of template.parameters) {
        const def = paramDefs?.[param.name] || {};
        params.push({
          name: param.name,
          description: def.description || "",
          type: def.type || typeof param.default,
          required: paramOrder.includes(param.name),
        });
      }
    }
    return { template: path.basename(templatePath), parameters: params };
  }

  private renderMarkdown(doc: TemplateDoc): string {
    let md = `# Template: ${doc.template}\n\n`;
    if (doc.parameters.length === 0) {
      md += "_No parameters defined._\n";
      return md;
    }
    md +=
      "| Name | Type | Required | Description |\n|------|------|----------|-------------|\n";
    for (const p of doc.parameters) {
      md += `| ${p.name} | ${p.type || ""} | ${p.required ? "yes" : "no"} | ${p.description || ""} |\n`;
    }
    return md;
  }
}

// CLI usage
// CLI usage for ES module
// Only run CLI if this file is the entry point
const isMain = (() => {
  const scriptPath = process.argv[1] ? path.resolve(process.argv[1]) : "";
  return import.meta.url === `file://${scriptPath}`;
})();

if (isMain) {
  // Parse CLI arguments for --templates and --docs
  let templatesDir: string | undefined = undefined;
  let docsDir: string | undefined = undefined;
  for (let i = 2; i < process.argv.length; ++i) {
    if (process.argv[i] === "--templates" && process.argv[i + 1]) {
      templatesDir = process.argv[i + 1];
      i++;
    } else if (process.argv[i] === "--docs" && process.argv[i + 1]) {
      docsDir = process.argv[i + 1];
      i++;
    }
  }
  const generator = new TemplateDocumentGenerator(templatesDir, docsDir);
  generator.generate();
  console.log(`Documentation generated in ${generator.docsDir}`);
}
