#!/usr/bin/env node
/**
 * validateTemplates.js
 *
 * Recursively finds all directories named 'templates' in the workspace and validates all .json files inside them
 * against schemas/template.schema.json using the JsonValidator class.
 *
 * Usage: node scripts/validateTemplates.js
 */

import { JsonValidator } from "../dist/jsonvalidator.mjs";
import fs from "fs";
import path from "path";

import { fileURLToPath } from "url";
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const rootDir = path.resolve(__dirname, "..");
const schemaPath = path.join(rootDir, "schemas", "template.schema.json");

function findTemplateDirs(dir) {
  let results = [];
  const entries = fs.readdirSync(dir, { withFileTypes: true });
  for (const entry of entries) {
    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === "templates") {
        results.push(fullPath);
      } else {
        results = results.concat(findTemplateDirs(fullPath));
      }
    }
  }
  return results;
}

function validateTemplates() {
  let validator;
  try {
    validator = JsonValidator.getInstance(path.join(rootDir, "schemas"));
  } catch (err) {
    console.error("Schema validation failed during validator initialization:");
    if (err && err.details) {
      for (const detail of err.details) {
        console.error(`  - ${detail.message || detail}`);
      }
    } else {
      console.error(err);
    }
    process.exit(2);
  }
  const templateDirs = findTemplateDirs(rootDir);
  let hasError = false;
  const jsonBase = path.join(rootDir, "json");
  for (const dir of templateDirs) {
    const files = fs.readdirSync(dir).filter((f) => f.endsWith(".json"));
    for (const file of files) {
      const filePath = path.join(dir, file);
      const relPath = path.relative(jsonBase, filePath);
      try {
        validator.serializeJsonFileWithSchema(filePath, schemaPath);
        console.log(`✔ Valid: ${relPath}`);
      } catch (err) {
        hasError = true;
        const schemaName = path.basename(schemaPath);
        console.error(`✖ Invalid: ${relPath} [${schemaName}]`);
        if (err && err.details) {
          for (const detail of err.details) {
            const isAdditional =
              detail.message &&
              detail.message.includes("must NOT have additional properties");
            if (
              isAdditional &&
              detail.params &&
              detail.params.additionalProperty
            ) {
              console.error(
                `  - ${detail.message} (property: '${detail.params.additionalProperty}')${detail.line ? " (line " + detail.line + ")" : ""}`,
              );
            } else {
              console.error(
                `  - ${detail.message}${detail.line ? " (line " + detail.line + ")" : ""}`,
              );
            }
          }
        } else {
          console.error(err);
        }
      }
    }
  }
  if (hasError) {
    process.exit(1);
  } else {
    console.log("All template files are valid.");
  }
}

validateTemplates();
