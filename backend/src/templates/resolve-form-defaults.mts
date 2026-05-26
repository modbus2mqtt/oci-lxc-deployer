import { IParameter, IOutputObject } from "../types.mjs";

/**
 * Resolves `{{ var }}` placeholders inside parameter `default` values BEFORE
 * they reach the frontend form.
 *
 * Without this, defaults like `mtls_cns: "{{ hostname }}"` (from
 * parameter-definitions.json) reach the form as the literal template string,
 * the user submits unchanged, and the backend then signs a client certificate
 * with the literal CN `{{ hostname }}` — which the openssl `-subj` validator
 * rightly rejects. Same root for any other consumer that reads a parameter
 * value directly (not via the script-side 2-pass `VariableResolver`).
 *
 * Resolution rules:
 *  - Replace `{{ name }}` with the value of `name` from (in order)
 *    `extraContext` → other parameter defaults → application properties
 *    (`value` first, then `default`).
 *  - Unresolvable references (e.g. stack-injected `{{ POSTGRES_PASSWORD }}`)
 *    are preserved as-is so the form still shows the marker — the user knows
 *    the value will be injected at deploy time.
 *  - Multi-pass (up to 5 iterations) so chained references like
 *    `envs` containing `{{ POSTGRES_HOST }}` (which itself is resolvable)
 *    cascade correctly.
 *  - String defaults only. Numeric/boolean defaults are returned unchanged.
 */
export function resolveFormDefaults(
  filteredParams: IParameter[],
  allParams: IParameter[],
  properties: IOutputObject[] | undefined,
  extraContext: Record<string, string> | undefined,
): IParameter[] {
  const map = buildResolutionMap(allParams, properties, extraContext);
  cascadeMap(map);

  return filteredParams.map((p) => {
    if (typeof p.default !== "string" || !p.default.includes("{{")) return p;
    const resolved = substituteOnce(p.default, map);
    if (resolved === p.default) return p;
    return { ...p, default: resolved };
  });
}

function buildResolutionMap(
  allParams: IParameter[],
  properties: IOutputObject[] | undefined,
  extraContext: Record<string, string> | undefined,
): Map<string, string> {
  const map = new Map<string, string>();

  // Properties: `value` (read-only) preferred, then `default`.
  for (const prop of properties ?? []) {
    if (prop.value !== undefined && !Array.isArray(prop.value)) {
      map.set(prop.id, String(prop.value));
    } else if (prop.default !== undefined) {
      map.set(prop.id, String(prop.default));
    }
  }

  // Parameters override properties (a parameter with a more specific default
  // wins). Skip params whose default is undefined — leave property mapping in
  // place if present.
  for (const p of allParams) {
    if (p.default !== undefined && p.default !== null) {
      map.set(p.id, String(p.default));
    }
  }

  // extraContext (e.g. veContext-derived values like project_domain_suffix)
  // overrides parameter defaults — these are the most-resolved values.
  if (extraContext) {
    for (const [k, v] of Object.entries(extraContext)) {
      if (v !== undefined && v !== null) map.set(k, String(v));
    }
  }

  return map;
}

const PLACEHOLDER_RE = /\{\{\s*([A-Za-z_][A-Za-z0-9_]*)\s*\}\}/g;

function substituteOnce(input: string, map: Map<string, string>): string {
  return input.replace(PLACEHOLDER_RE, (match, name) => {
    const replacement = map.get(name);
    return replacement !== undefined ? replacement : match;
  });
}

/**
 * Repeatedly substitute values in `map` against themselves until no further
 * change. Each iteration replaces resolvable references in every value.
 * Bounded to 5 passes to guarantee termination even if someone introduces a
 * cycle (the original 2-pass resolver was 2, but defaults can chain deeper
 * than scripts).
 */
function cascadeMap(map: Map<string, string>): void {
  for (let i = 0; i < 5; i++) {
    let changed = false;
    for (const [k, v] of map) {
      if (!v.includes("{{")) continue;
      const next = substituteOnce(v, map);
      if (next !== v) {
        map.set(k, next);
        changed = true;
      }
    }
    if (!changed) return;
  }
}
