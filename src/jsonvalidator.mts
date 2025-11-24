import { parse as parseWithSourceMap } from "json-source-map";

import { Ajv, ErrorObject } from "ajv";
import ajvErrors from "ajv-errors";
import { readFileSync, readdirSync } from "fs";
import path, { resolve, extname, join } from "path";
export interface IJsonErrorDetails {
  line?: number;
  error: Error;
}
export class JsonError extends Error {
  public details: IJsonErrorDetails[]|undefined;
  public filename: string;

  constructor(filename: string, details?: IJsonErrorDetails[]) {
    super(`'${filename}' has errors. ` + (details && details.length > 1? `See details for ${details.length} errors.` : ""));
    this.name = "JsonError";
    this.filename = filename;
    this.details = details;
  }
}
export class ValidateJsonError extends Error {
   constructor(filename: string, result: ErrorObject) {
    super(`'${filename}': Validation error ${result.instancePath} ${result.message || "Unknown validation error"}`);
    this.name = "ValidateJsonError";
  } 
 
}
export class JsonValidator {
  static instance: JsonValidator | undefined;
  static getInstance(
    schemaPath: string,
    baseSchemas: string[] = ["templatelist.schema.json"],
  ): JsonValidator {
    if (!JsonValidator.instance) {
      JsonValidator.instance = new JsonValidator(schemaPath, baseSchemas);
    }
    return JsonValidator.instance;
  }
  private ajv: Ajv;
  private constructor(
    schemasDir: string = resolve("schemas"),
    baseSchemas: string[] = ["templatelist.schema.json"],
  ) {
    this.ajv = new Ajv({
      allErrors: true,
      strict: true,
      allowUnionTypes: true,
    });
    ajvErrors.default(this.ajv);
    // Validate and add all .schema.json files
    let allFiles: string[] = [];
    const files = readdirSync(schemasDir).filter((f) => extname(f) === ".json");
    // 1. Basis-Schemas zuerst
    for (const file of baseSchemas) {
      if (files.includes(file)) allFiles.push(file);
    }
    for (const file of files) {
      if (!baseSchemas.includes(file)) {
        allFiles.push(file);
      }
    }
    let errors: IJsonErrorDetails[] = [];
    for (const file of allFiles) {
      try {
        const schemaPath = join(schemasDir, file);
        const schemaContent = readFileSync(schemaPath, "utf-8");
        const schema = JSON.parse(schemaContent);
        this.ajv.addSchema(schema, file);
        this.ajv.compile(schema);
      } catch (err: Error | any) {
        errors.push({ line: -1, error: err  as Error});
      }
    }
    if (errors.length > 0) {
      throw new JsonError(
        "",
        errors
      );
    }
  }

  /**
   * Validates and serializes a JSON object against a schema. Throws on validation error.
   * Only supports synchronous schemas (no async validation).
   * @param jsonData The data to validate and serialize
   * @param schemaId The path to the schema file
   * @returns The validated and typed object
   */
  public serializeJsonWithSchema<T>(jsonData: unknown, schemaId: string): T {
    const schemaKey = path.basename(schemaId);
    const validate = this.ajv.getSchema<T>(schemaKey);
    if (!validate) {
      throw new Error(
        `Schema not found: ${schemaKey} (while validating file: ${schemaId})`,
      );
    }
    let valid: boolean = false;
    let sourceMap: any = undefined;
    let originalText: string | undefined = undefined;
    // Try to get line numbers if jsonData is a plain object from JSON.parse
    if (
      typeof jsonData === "object" &&
      jsonData !== null &&
      (jsonData as any).__sourceMapText
    ) {
      originalText = (jsonData as any).__sourceMapText;
      sourceMap = (jsonData as any).__sourceMap;
    }
    try {
      const result = validate(jsonData);
      if (result instanceof Promise) {
        throw new Error(
          "Async schemas are not supported in serializeJsonWithSchema",
        );
      } else {
        valid = result as boolean;
      }
    } catch (err: any) {
      throw new Error(
        `Validation error in file '${schemaId}': ${err && (err.message || String(err))}`,
      );
    }
    if (!valid) {
      let details: IJsonErrorDetails[] = [];
      if (validate.errors && originalText && sourceMap) {
        details = validate.errors.map((e: ErrorObject): IJsonErrorDetails => {
          const pointer = sourceMap.pointers[e.instancePath || ""];
          const line = pointer
            ? pointer.key
              ? pointer.key.line + 1
              : pointer.value.line + 1
            : -1;
          return {
            line,
            error: new ValidateJsonError(schemaKey, e)
          };
        });
      } else if (validate.errors) {
        details = validate.errors.map((e: ErrorObject): IJsonErrorDetails  => ({
          error: new ValidateJsonError(schemaKey, e)
        }));
      } else {
        details = [{ line: -1, error: new Error("Unknown error") }];
      }
      throw new JsonError(schemaId, details);
    }
    return jsonData as T;
  }

  /**
   * Reads a JSON file, parses it with source map, validates it against a schema, and returns the typed object.
   * Throws an error with line numbers if file is missing, parsing or validation fails.
   * @param filePath Path to the JSON file
   * @param schemaPath Path to the schema file
   */
  public serializeJsonFileWithSchema<T>(
    filePath: string,
    schemaPath: string,
  ): T {
    let fileText: string;
    let data: unknown;
    let pointers: any;
    try {
      fileText = readFileSync(filePath, "utf-8");
    } catch (e: any) {
      throw new Error(
        `File not found or cannot be read: ${filePath}\n${e && (e.message || String(e))}`,
      );
    }
    try {
      const parsed = parseWithSourceMap(fileText);
      data = parsed.data;
      pointers = parsed.pointers;
      (data as any).__sourceMapText = fileText;
      (data as any).__sourceMap = { pointers };
    } catch (e: any) {
      // Try to extract line/column from error if possible
      throw new Error(
        `Failed to parse JSON file: ${filePath}\n${e && (e.message || String(e))}`,
      );
    }
    try {
      return this.serializeJsonWithSchema<T>(data, schemaPath);
    } catch (e: any) {
      const err = new Error(
        `Validation failed for file: ${filePath}\n${e && (e.message || String(e))}`,
      );
      if (e && typeof e === "object" && "errorLines" in e) {
        (err as any).errorLines = (e as any).errorLines;
      }
      throw err;
    }
  }
}
