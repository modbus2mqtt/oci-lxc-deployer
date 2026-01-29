import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { DocumentationGenerator } from "@src/documentation-generator.mjs";
import { createTestEnvironment, type TestEnvironment } from "../helper/test-environment.mjs";
import { TestPersistenceHelper, Volume } from "@tests/helper/test-persistence-helper.mjs";

describe("DocumentationGenerator skip_if_property_set", () => {
  let env: TestEnvironment;
  let persistenceHelper: TestPersistenceHelper;
  let jsonPath: string;
  let localPath: string;
  let schemaPath: string;
  let htmlPath: string;

  beforeAll(() => {
    env = createTestEnvironment(import.meta.url, {
      jsonIncludePatterns: [],
    });
    env.initPersistence({ enableCache: false });
    persistenceHelper = new TestPersistenceHelper({
      repoRoot: env.repoRoot,
      localRoot: env.localDir,
      jsonRoot: env.jsonDir,
      schemasRoot: env.schemaDir,
    });

    jsonPath = env.jsonDir;
    localPath = env.localDir;
    schemaPath = env.schemaDir;
    htmlPath = persistenceHelper.resolve(Volume.LocalRoot, "html");

    // Create test application.json
    const appJson = {
      name: "Test Skip Property Set Doc Application",
      description: "A test application for skip_if_property_set documentation",
      installation: [
        "set-parameters.json",
        "skip-if-property-set-template.json",
      ],
    };
    persistenceHelper.writeJsonSync(
      Volume.JsonApplications,
      "test-skip-property-set-doc-app/application.json",
      appJson,
    );

    // Create test set-parameters.json template
    const setParamsTemplate = {
      name: "Set Parameters",
      description: "Sets application-specific parameters",
      execute_on: "ve",
      commands: [
        {
          properties: [
            { id: "myvariable", value: "test-value" },
          ],
        },
      ],
      parameters: [
        {
          id: "hostname",
          name: "Hostname",
          type: "string",
          required: true,
          description: "Hostname for the container",
        },
      ],
    };
    persistenceHelper.writeJsonSync(
      Volume.JsonApplications,
      "test-skip-property-set-doc-app/templates/set-parameters.json",
      setParamsTemplate,
    );

    // Create test template with skip_if_property_set
    const skipIfPropertySetTemplate = {
      name: "Skip If Property Set Template",
      description: "Template that is skipped if myvariable is set",
      execute_on: "ve",
      skip_if_property_set: "myvariable",
      commands: [
        {
          name: "Test Command",
          command: "echo 'test command'",
          description: "Test command that should be skipped",
        },
      ],
      parameters: [
        {
          id: "other_param",
          name: "Other Parameter",
          type: "string",
          required: false,
          description: "Other parameter",
        },
      ],
    };
    persistenceHelper.writeJsonSync(
      Volume.JsonApplications,
      "test-skip-property-set-doc-app/templates/skip-if-property-set-template.json",
      skipIfPropertySetTemplate,
    );
  });

  afterAll(() => {
    env.cleanup();
  });

  it("should mark template as skipped in Application.md when skip_if_property_set variable is set", async () => {
    const generator = new DocumentationGenerator(jsonPath, localPath, schemaPath, htmlPath);
    
    // Generate documentation for the test application
    await generator.generateDocumentation("test-skip-property-set-doc-app");
    
    // Read the generated README.md (it's generated in htmlPath, not in jsonPath)
    expect(() =>
      persistenceHelper.readTextSync(
        Volume.LocalRoot,
        "html/test-skip-property-set-doc-app.md",
      ),
    ).not.toThrow();

    const readmeContent = persistenceHelper.readTextSync(
      Volume.LocalRoot,
      "html/test-skip-property-set-doc-app.md",
    );
    
    // Check that the template is marked as skipped
    // The status should indicate that it's conditionally executed and skipped
    expect(readmeContent).toContain("skip-if-property-set-template.json");
    
    // The template should appear in the Installation Templates section
    expect(readmeContent).toMatch(/skip-if-property-set-template/i);
    
    // Check that the template is recognized as conditionally executed
    // (skip_if_property_set makes it conditional)
    // The template should be marked with a conditional status
    // Since skip_if_property_set is set, the template is conditional
    const lines = readmeContent.split('\n');
    const templateLine = lines.find(line => line.includes('skip-if-property-set-template'));
    expect(templateLine).toBeTruthy();
    if (templateLine) {
      // The line should contain the template name and a status indicator
      // Since skip_if_property_set is set, the template is conditional
      // The status should be "⚠️ Conditional" or similar
      expect(templateLine).toMatch(/⚠️|Conditional|conditional/i);
    }
  });

  it("should recognize skip_if_property_set as conditional in template analyzer", async () => {
    const { TemplateAnalyzer } = await import("@src/templates/template-analyzer.mjs");
    const { DocumentationPathResolver } = await import("@src/documentation-path-resolver.mjs");
    
    const pathResolver = new DocumentationPathResolver(jsonPath, localPath);
    const templateAnalyzer = new TemplateAnalyzer(pathResolver, {
      jsonPath,
      schemaPath,
      localPath,
    });
    
    const templateData = persistenceHelper.readJsonSync(
      Volume.JsonApplications,
      "test-skip-property-set-doc-app/templates/skip-if-property-set-template.json",
    );
    
    // Check that skip_if_property_set is recognized as conditional
    const isConditional = templateAnalyzer.isConditionallyExecuted(templateData);
    expect(isConditional).toBe(true);
  });
});

