import { parse as parseWithSourceMap } from "json-source-map";

import { Ajv, ErrorObject } from "ajv";
import ajvErrors from "ajv-errors";
import fs from "fs";
import path, { resolve, extname, join } from "path";
import { IJsonError } from "./types.mjs";

export class JsonError extends Error implements IJsonError {
  public static baseDir: string = "";
  public details: IJsonError[] | undefined;
  public filename?: string | undefined;

  constructor(
    private passed_message: string,
    details?: IJsonError[],
    filename?: string | undefined,
  ) {
    super();
    this.name = "JsonError";
    this.filename = filename;
    this.details = details;
  }
  get message(): string {
    const rel =
      this.filename !== undefined
        ? path.relative(JsonError.baseDir, this.filename)
        : "";
    return (
      rel +
      this.passed_message +
      (this.details && this.details.length == 0 ? this.passed_message : "") +
      (this.details && this.details.length > 1
        ? ` See details for ${this.details.length} errors.`
        : "")
    );
  }
  toJSON(): IJsonError {
    const obj: any = {
      name: this.name,
      message: this.message,
      line: (this as any).line,
      details: this.details
        ? this.details.map((d) =>
            typeof (d as any).toJSON === "function" ? (d as any).toJSON() : d,
          )
        : undefined,
    };
    if (this.filename !== undefined) obj.filename = this.filename;
    return obj as IJsonError;
  }
}
export class ValidateJsonError extends JsonError implements IJsonError {
  line?: number;
  constructor(result: ErrorObject, filename?: string, _line?: number) {
     let property = result.params.additionalProperty
      if( property ) 
        property = " '" + property + "'";
      else
        property = "";
    super(
      (filename ? filename + ":" : "") +
        ` Validation error ${result.instancePath} ${result.message || "Unknown validation error"}${property}`
    );
    this.name = "ValidateJsonError";
    if (_line !== undefined) this.line = _line;
  }
}
export class JsonValidator {
  private ajv: Ajv;
  constructor(
    schemasDir: string = resolve("schemas"),
    baseSchemas: string[] = ["templatelist.schema.json"],
  ) {
    this.ajv = new Ajv({
      allErrors: true,
      strict: true,
      strictRequired: false,
      allowUnionTypes: true,
    });
    ajvErrors.default(this.ajv);
    // Validate and add all .schema.json files
    let allFiles: string[] = [];
    const files = fs
      .readdirSync(schemasDir)
      .filter((f) => extname(f) === ".json");
    // 1. Basis-Schemas zuerst
    for (const file of baseSchemas) {
      if (files.includes(file)) allFiles.push(file);
    }
    for (const file of files) {
      if (!baseSchemas.includes(file)) {
        allFiles.push(file);
      }
    }
    let errors: IJsonError[] = [];
    for (const file of allFiles) {
      try {
        const schemaPath = join(schemasDir, file);
        const schemaContent = fs.readFileSync(schemaPath, "utf-8");
        const schema = JSON.parse(schemaContent);
        this.ajv.addSchema(schema, file);
        this.ajv.compile(schema);
      } catch (err: Error | any) {
        errors.push(err);
      }
    }
    if (errors.length > 0) {
      throw new JsonError("", errors);
    }
  }

  /**
   * Validates and serializes a JSON object against a schema. Throws on validation error.
   * Only supports synchronous schemas (no async validation).
   * @param jsonData The data to validate and serialize
   * @param schemaId The path to the schema file
   * @returns The validated and typed object
   */
  public serializeJsonWithSchema<T>(
    jsonData: unknown,
    schemaId: string,
    filePath?: string,
  ): T {
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
    let dataToValidate: any = structuredClone(jsonData);
    if (
      typeof jsonData === "object" &&
      jsonData !== null &&
      (jsonData as any).__sourceMapText
    ) {
      originalText = (jsonData as any).__sourceMapText;
      sourceMap = (jsonData as any).__sourceMap;
    }
    try {
      if (dataToValidate.__sourceMapText)
        delete (dataToValidate as any).__sourceMapText;
      if (dataToValidate.__sourceMap)
        delete (dataToValidate as any).__sourceMap;
      const result = validate(dataToValidate);
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
      let details: IJsonError[] = [];
      if (validate.errors && originalText && sourceMap) {
        details = validate.errors.map((e: ErrorObject): IJsonError => {
          const pointer = sourceMap.pointers[e.instancePath || ""];
          const line = pointer
            ? pointer.key
              ? pointer.key.line + 1
              : pointer.value.line + 1
            : -1;
          return new ValidateJsonError(e, undefined, line);
        });
      } else if (validate.errors) {
        details = validate.errors.map(
          (e: ErrorObject): IJsonError =>
            new ValidateJsonError(e, filePath ? filePath : undefined),
        );
      } else {
        details = [new JsonError("Unknown error")];
      }

      throw new JsonError("Validation error", details);
    }
    return jsonData as T;
  }

  /**
   * Reads a JSON file, parses it with source map, validates it against a schema, and returns the typed object.
   * Throws an error with line numbers if file is missing, parsing or validation fails.
   * @param filePath Path to the JSON file
   * @param schemaKey Path to the schema file
   */
  public serializeJsonFileWithSchema<T>(
    filePath: string,
    schemaKey: string,
  ): T {
    let fileText: string;
    let data: unknown;
    let pointers: any;
    try {
      fileText = fs.readFileSync(filePath, "utf-8");
    } catch (e: any) {
      throw new Error(
        `File not found or cannot be read: ${filePath}\n${e && (e.message || String(e))}`,
      );
    }
    const parsed = parseWithSourceMap(fileText);
    data = parsed.data;
    pointers = parsed.pointers;
    (data as any).__sourceMapText = fileText;
    (data as any).__sourceMap = { pointers };
    return this.serializeJsonWithSchema<T>(data, schemaKey, filePath);
  }
}
