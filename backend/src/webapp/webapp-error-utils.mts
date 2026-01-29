import { IJsonError } from "@src/types.mjs";
import { JsonError } from "../jsonvalidator.mjs";
import { VEConfigurationError } from "../backend-types.mjs";

/**
 * Determines the appropriate HTTP status code for an error.
 * Returns 422 (Unprocessable Entity) for validation/configuration errors,
 * 500 (Internal Server Error) for unexpected server errors.
 */
export function getErrorStatusCode(err: unknown): number {
  if (err instanceof JsonError || err instanceof VEConfigurationError) {
    return 422;
  }
  if (err && typeof err === "object" && "name" in err) {
    const errorName = (err as { name?: string }).name;
    if (
      errorName === "JsonError" ||
      errorName === "VEConfigurationError" ||
      errorName === "ValidateJsonError"
    ) {
      return 422;
    }
  }
  return 500;
}

/**
 * Recursively serializes an array of details, handling both JsonError instances and plain objects.
 */
export function serializeDetailsArray(
  details: IJsonError[] | undefined,
): IJsonError[] | undefined {
  if (!details || !Array.isArray(details)) {
    return undefined;
  }

  return details.map((d) => {
    if (d && typeof d === "object" && typeof (d as any).toJSON === "function") {
      return (d as any).toJSON();
    }

    if (d && typeof d === "object") {
      const result: any = {
        name: (d as any).name,
        message: (d as any).message,
        line: (d as any).line,
      };

      if ((d as any).details && Array.isArray((d as any).details)) {
        result.details = serializeDetailsArray((d as any).details);
      }

      if ((d as any).filename !== undefined) result.filename = (d as any).filename;

      return result as IJsonError;
    }

    return {
      name: "Error",
      message: String(d),
      details: undefined,
    } as IJsonError;
  });
}

/**
 * Converts an error to a serializable JSON object.
 * Uses toJSON() if available, otherwise extracts error properties.
 */
export function serializeError(err: unknown): any {
  if (!err) {
    return { message: "Unknown error" };
  }

  if (
    err &&
    typeof err === "object" &&
    "toJSON" in err &&
    typeof (err as any).toJSON === "function"
  ) {
    return (err as any).toJSON();
  }

  if (err instanceof Error) {
    const errorObj: any = {
      name: err.name,
      message: err.message,
    };

    if (process.env.NODE_ENV !== "production" && err.stack) {
      errorObj.stack = err.stack;
    }

    if (err instanceof JsonError || err instanceof VEConfigurationError) {
      if (typeof (err as any).toJSON === "function") {
        return (err as any).toJSON();
      }
      if ((err as any).details) {
        errorObj.details = serializeDetailsArray((err as any).details);
      }
      if ((err as any).filename) {
        errorObj.filename = (err as any).filename;
      }
    }

    return errorObj;
  }

  if (typeof err === "string") {
    return { message: err };
  }

  try {
    return JSON.parse(JSON.stringify(err));
  } catch {
    return { message: String(err) };
  }
}
