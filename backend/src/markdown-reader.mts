import fs from "fs";
import path from "path";

/**
 * Service for reading markdown files and extracting sections based on headings.
 * Used to provide parameter descriptions from external .md files.
 */
export class MarkdownReader {
  private static normalizeHeadingName(name: string): string {
    let s = name.trim().toLowerCase();
    // Strip GitHub-style anchors like `{#id}` at end
    s = s.replace(/\s*\{#.*\}\s*$/, "");
    // Strip trailing colon(s)
    s = s.replace(/:+\s*$/, "");
    // Strip surrounding backticks
    s = s.replace(/^`+|`+$/g, "");
    // Collapse internal whitespace
    s = s.replace(/\s+/g, " ");
    return s;
  }
  // Preserve original case for display while removing anchors/backticks/colons and normalizing whitespace
  private static cleanHeadingDisplay(name: string): string {
    let s = name.trim();
    s = s.replace(/\s*\{#.*\}\s*$/, "");
    s = s.replace(/:+\s*$/, "");
    s = s.replace(/^`+|`+$/g, "");
    s = s.replace(/\s+/g, " ");
    return s;
  }
  /**
   * Reads a markdown file and extracts a specific section based on heading name.
   * Sections are defined by ## headings. Returns text from heading until next ## or EOF.
   *
   * @param mdFilePath Absolute path to the .md file
   * @param sectionName Name of the section (heading without ##)
   * @returns Section content as string, or null if section not found or file doesn't exist
   */
  static extractSection(
    mdFilePath: string,
    sectionName: string,
  ): string | null {
    if (!fs.existsSync(mdFilePath)) {
      return null;
    }

    try {
      const content = fs.readFileSync(mdFilePath, "utf-8");
      const lines = content.split(/\r?\n/);

      // Normalize section name for comparison (trim, lowercase)
      const normalizedSectionName = this.normalizeHeadingName(sectionName);

      let inSection = false;
      let sectionContent: string[] = [];

      for (const line of lines) {
        // Check if this is a ## heading
        const headingMatch = line.match(/^##\s+(.+)$/);

        if (headingMatch) {
          const headingName = MarkdownReader.normalizeHeadingName(
            headingMatch[1]!,
          );

          if (headingName === normalizedSectionName) {
            // Found our section
            inSection = true;
            continue; // Skip the heading line itself
          } else if (inSection) {
            // Found next section, stop collecting
            break;
          }
        } else if (inSection) {
          // Collect lines in our section
          sectionContent.push(line);
        }
      }

      if (sectionContent.length === 0) {
        return null;
      }

      // Trim leading and trailing empty lines
      while (sectionContent.length > 0 && sectionContent[0]!.trim() === "") {
        sectionContent.shift();
      }
      while (
        sectionContent.length > 0 &&
        sectionContent[sectionContent.length - 1]!.trim() === ""
      ) {
        sectionContent.pop();
      }

      return sectionContent.join("\n");
    } catch {
      // File read error
      return null;
    }
  }

  /**
   * Gets the path to the markdown file for a given template.
   * Assumes .md file has same name as template file, in same directory.
   *
   * @param templateFilePath Absolute path to template JSON file
   * @returns Path to corresponding .md file (may not exist)
   */
  static getMarkdownPath(templateFilePath: string): string {
    const dir = path.dirname(templateFilePath);
    const basename = path.basename(templateFilePath, ".json");
    return path.join(dir, `${basename}.md`);
  }

  /**
   * Checks if a markdown file exists for a given template.
   *
   * @param templateFilePath Absolute path to template JSON file
   * @returns true if .md file exists, false otherwise
   */
  static hasMarkdownFile(templateFilePath: string): boolean {
    const mdPath = this.getMarkdownPath(templateFilePath);
    return fs.existsSync(mdPath);
  }

  /**
   * Lists all section headings (## level) in a markdown file.
   * Useful for debugging or validation.
   *
   * @param mdFilePath Absolute path to the .md file
   * @returns Array of heading names, or empty array if file doesn't exist
   */
  static listSections(mdFilePath: string): string[] {
    if (!fs.existsSync(mdFilePath)) {
      return [];
    }

    try {
      const content = fs.readFileSync(mdFilePath, "utf-8");
      const lines = content.split(/\r?\n/);
      const sections: string[] = [];

      for (const line of lines) {
        const headingMatch = line.match(/^##\s+(.+)$/);
        if (headingMatch) {
          sections.push(MarkdownReader.cleanHeadingDisplay(headingMatch[1]!));
        }
      }

      return sections;
    } catch {
      return [];
    }
  }
}
