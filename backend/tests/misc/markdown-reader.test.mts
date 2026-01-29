import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { MarkdownReader } from "../../src/markdown-reader.mjs";
import { createTestEnvironment, type TestEnvironment } from "../helper/test-environment.mjs";
import { TestPersistenceHelper, Volume } from "@tests/helper/test-persistence-helper.mjs";

describe("MarkdownReader", () => {
  let env: TestEnvironment;
  let persistenceHelper: TestPersistenceHelper;
  let testMdFile: string;

  beforeEach(() => {
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
    testMdFile = persistenceHelper.resolve(
      Volume.LocalRoot,
      "markdown-reader/test-template.md",
    );
  });

  afterEach(() => {
    env.cleanup();
  });

  describe("extractSection", () => {
    it("should extract section content from markdown file", () => {
      // Create test markdown file
      const markdownContent = `# Test Template

## Volumes

Volume mappings in key=value format, one per line.

**Format:** \`key=path\` or \`key=path,permissions\`

**Examples:**
- volume1=/var/lib/data,0700
- volume2=/var/lib/logs,0755

## Host Mountpoint

Mountpoint on the Proxmox host.
`;

      persistenceHelper.writeTextSync(
        Volume.LocalRoot,
        "markdown-reader/test-template.md",
        markdownContent,
      );

      // Extract "Volumes" section
      const volumesSection = MarkdownReader.extractSection(testMdFile, "Volumes");

      expect(volumesSection).toBeTruthy();
      expect(volumesSection).toContain("Volume mappings in key=value format");
      expect(volumesSection).toContain("**Format:**");
      expect(volumesSection).toContain("**Examples:**");
      expect(volumesSection).toContain("volume1=/var/lib/data,0700");
      // Should NOT contain next section
      expect(volumesSection).not.toContain("Mountpoint on the Proxmox host");
    });

    it("should return null if section not found", () => {
      const markdownContent = `# Test Template

## Other Section

Some content here.
`;

      persistenceHelper.writeTextSync(
        Volume.LocalRoot,
        "markdown-reader/test-template.md",
        markdownContent,
      );

      const result = MarkdownReader.extractSection(testMdFile, "NonExistent");

      expect(result).toBeNull();
    });

    it("should return null if file does not exist", () => {
      const nonExistentFile = persistenceHelper.resolve(
        Volume.LocalRoot,
        "markdown-reader/nonexistent.md",
      );

      const result = MarkdownReader.extractSection(nonExistentFile, "Volumes");

      expect(result).toBeNull();
    });

    it("should handle case-insensitive section names", () => {
      const markdownContent = `## Volumes

Test content
`;

      persistenceHelper.writeTextSync(
        Volume.LocalRoot,
        "markdown-reader/test-template.md",
        markdownContent,
      );

      const result1 = MarkdownReader.extractSection(testMdFile, "Volumes");
      const result2 = MarkdownReader.extractSection(testMdFile, "volumes");
      const result3 = MarkdownReader.extractSection(testMdFile, "VOLUMES");

      expect(result1).toBe("Test content");
      expect(result2).toBe("Test content");
      expect(result3).toBe("Test content");
    });

    it("should trim leading and trailing empty lines", () => {
      const markdownContent = `## Volumes


Content line 1
Content line 2


## Next Section
`;

      persistenceHelper.writeTextSync(
        Volume.LocalRoot,
        "markdown-reader/test-template.md",
        markdownContent,
      );

      const result = MarkdownReader.extractSection(testMdFile, "Volumes");

      expect(result).toBe("Content line 1\nContent line 2");
      expect(result?.startsWith('\n')).toBe(false);
      expect(result?.endsWith('\n')).toBe(false);
    });

    it("should extract section until end of file if no next section", () => {
      const markdownContent = `## Volumes

Line 1
Line 2
Line 3
`;

      persistenceHelper.writeTextSync(
        Volume.LocalRoot,
        "markdown-reader/test-template.md",
        markdownContent,
      );

      const result = MarkdownReader.extractSection(testMdFile, "Volumes");

      expect(result).toBe("Line 1\nLine 2\nLine 3");
    });
  });

  describe("getMarkdownPath", () => {
    it("should return .md path for template JSON file", () => {
      const templatePath = "/path/to/templates/160-bind-volumes.json";

      const mdPath = MarkdownReader.getMarkdownPath(templatePath);

      expect(mdPath).toBe("/path/to/templates/160-bind-volumes.md");
    });

    it("should handle templates in subdirectories", () => {
      const templatePath = "/path/to/shared/templates/test-template.json";

      const mdPath = MarkdownReader.getMarkdownPath(templatePath);

      expect(mdPath).toBe("/path/to/shared/templates/test-template.md");
    });
  });

  describe("hasMarkdownFile", () => {
    it("should return true if markdown file exists", () => {
      const templatePath = persistenceHelper.resolve(
        Volume.LocalRoot,
        "markdown-reader/test-template.json",
      );
      persistenceHelper.writeTextSync(
        Volume.LocalRoot,
        "markdown-reader/test-template.json",
        "{}",
      );
      persistenceHelper.writeTextSync(
        Volume.LocalRoot,
        "markdown-reader/test-template.md",
        "# Test",
      );

      const result = MarkdownReader.hasMarkdownFile(templatePath);

      expect(result).toBe(true);
    });

    it("should return false if markdown file does not exist", () => {
      const templatePath = persistenceHelper.resolve(
        Volume.LocalRoot,
        "markdown-reader/test-template.json",
      );
      persistenceHelper.writeTextSync(
        Volume.LocalRoot,
        "markdown-reader/test-template.json",
        "{}",
      );

      const result = MarkdownReader.hasMarkdownFile(templatePath);

      expect(result).toBe(false);
    });
  });

  describe("listSections", () => {
    it("should list all ## level headings", () => {
      const markdownContent = `# Main Title

## Volumes

Content

## Host Mountpoint

Content

### Subsection

Content

## Base Path

Content
`;

      persistenceHelper.writeTextSync(
        Volume.LocalRoot,
        "markdown-reader/test-template.md",
        markdownContent,
      );

      const sections = MarkdownReader.listSections(testMdFile);

      expect(sections).toEqual(["Volumes", "Host Mountpoint", "Base Path"]);
      expect(sections).not.toContain("Subsection"); // ### is not ##
    });

    it("should return empty array if file does not exist", () => {
      const nonExistentFile = persistenceHelper.resolve(
        Volume.LocalRoot,
        "markdown-reader/nonexistent.md",
      );

      const sections = MarkdownReader.listSections(nonExistentFile);

      expect(sections).toEqual([]);
    });

    it("should return empty array if no ## headings found", () => {
      const markdownContent = `# Main Title

Just some content without ## headings.

### Only subsections
`;

      persistenceHelper.writeTextSync(
        Volume.LocalRoot,
        "markdown-reader/test-template.md",
        markdownContent,
      );

      const sections = MarkdownReader.listSections(testMdFile);

      expect(sections).toEqual([]);
    });
  });
});
