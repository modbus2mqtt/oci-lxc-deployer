import { describe, it, expect } from "vitest";
import { resolveFormDefaults } from "@src/templates/resolve-form-defaults.mjs";
import { IParameter, IOutputObject } from "@src/types.mjs";

function p(id: string, def?: string | number | boolean): IParameter {
  return { id, type: "string", default: def } as IParameter;
}

describe("resolveFormDefaults", () => {
  it("replaces single-variable placeholder with property default", () => {
    const filtered: IParameter[] = [p("mtls_cns", "{{ hostname }}")];
    const properties: IOutputObject[] = [{ id: "hostname", default: "node-red" }];
    const result = resolveFormDefaults(filtered, filtered, properties, undefined);
    expect(result[0].default).toBe("node-red");
  });

  it("replaces single-variable placeholder with another parameter's default", () => {
    const all: IParameter[] = [
      p("hostname", "gitea"),
      p("mtls_cns", "{{ hostname }}"),
    ];
    const result = resolveFormDefaults(all, all, undefined, undefined);
    expect(result[1].default).toBe("gitea");
  });

  it("replaces multiple placeholders inside a composed URL template", () => {
    const all: IParameter[] = [
      p("hostname", "modbus2mqtt"),
      p(
        "oidc_redirect_uri",
        "https://{{ hostname }}{{ project_domain_suffix }}/api/auth/callback",
      ),
    ];
    const properties: IOutputObject[] = [
      { id: "project_domain_suffix", value: ".ohnewarum.de" },
    ];
    const result = resolveFormDefaults(all, all, properties, undefined);
    expect(result[1].default).toBe(
      "https://modbus2mqtt.ohnewarum.de/api/auth/callback",
    );
  });

  it("leaves unresolvable refs as `{{ name }}` literals", () => {
    const all: IParameter[] = [
      p(
        "envs",
        "POSTGRES_PASSWORD={{ POSTGRES_PASSWORD }}\nPOSTGRES_USER=postgres",
      ),
    ];
    const result = resolveFormDefaults(all, all, undefined, undefined);
    // Stack-injected ref stays as marker
    expect(result[0].default).toBe(
      "POSTGRES_PASSWORD={{ POSTGRES_PASSWORD }}\nPOSTGRES_USER=postgres",
    );
  });

  it("cascades chained references across multiple iterations", () => {
    const all: IParameter[] = [
      p("hostname", "gitea"),
      p("project_domain_suffix", ".ohnewarum.de"),
      p("base_url", "https://{{ hostname }}{{ project_domain_suffix }}"),
      p("oidc_redirect_uri", "{{ base_url }}/user/oauth2/zitadel/callback"),
    ];
    const result = resolveFormDefaults(all, all, undefined, undefined);
    expect(result[3].default).toBe(
      "https://gitea.ohnewarum.de/user/oauth2/zitadel/callback",
    );
  });

  it("extraContext overrides parameter defaults", () => {
    const all: IParameter[] = [
      p("hostname", "default-host"),
      p("oidc_redirect_uri", "https://{{ hostname }}/callback"),
    ];
    const result = resolveFormDefaults(
      all,
      all,
      undefined,
      { hostname: "override-host" },
    );
    expect(result[1].default).toBe("https://override-host/callback");
  });

  it("property `value` (read-only) beats property `default`", () => {
    const filtered: IParameter[] = [p("oidc_redirect_uri", "https://{{ hostname }}/")];
    const properties: IOutputObject[] = [
      { id: "hostname", default: "ignored", value: "winner" },
    ];
    const result = resolveFormDefaults(
      filtered,
      filtered,
      properties,
      undefined,
    );
    expect(result[0].default).toBe("https://winner/");
  });

  it("parameter default beats property default (later in chain)", () => {
    const all: IParameter[] = [p("hostname", "from-parameter")];
    const properties: IOutputObject[] = [{ id: "hostname", default: "from-property" }];
    const filtered: IParameter[] = [p("mtls_cns", "{{ hostname }}")];
    const result = resolveFormDefaults(filtered, all, properties, undefined);
    expect(result[0].default).toBe("from-parameter");
  });

  it("returns identical object reference when default is undefined", () => {
    const filtered: IParameter[] = [{ id: "x", type: "string" } as IParameter];
    const result = resolveFormDefaults(filtered, filtered, undefined, undefined);
    expect(result[0]).toBe(filtered[0]);
  });

  it("returns identical object when default contains no placeholder", () => {
    const filtered: IParameter[] = [p("hostname", "node-red")];
    const result = resolveFormDefaults(filtered, filtered, undefined, undefined);
    expect(result[0]).toBe(filtered[0]);
  });

  it("leaves numeric/boolean defaults untouched", () => {
    const filtered: IParameter[] = [
      { id: "port", type: "number", default: 3000 } as IParameter,
      { id: "enabled", type: "boolean", default: true } as IParameter,
    ];
    const result = resolveFormDefaults(filtered, filtered, undefined, undefined);
    expect(result[0].default).toBe(3000);
    expect(result[1].default).toBe(true);
  });

  it("partially resolves: mixed resolvable + unresolvable placeholders", () => {
    const all: IParameter[] = [
      p("hostname", "gitea"),
      p(
        "envs",
        "DB_HOST={{ POSTGRES_HOST }}\nROOT_URL=https://{{ hostname }}/",
      ),
    ];
    const result = resolveFormDefaults(all, all, undefined, undefined);
    expect(result[1].default).toBe(
      "DB_HOST={{ POSTGRES_HOST }}\nROOT_URL=https://gitea/",
    );
  });

  it("aborts after 5 iterations on accidental cycle (safety bound)", () => {
    // a → b → a — would loop forever without the bound. Behaviour: leaves
    // the placeholder in place (substitution oscillates, then halts).
    const all: IParameter[] = [
      p("a", "{{ b }}"),
      p("b", "{{ a }}"),
    ];
    // No expectation on final value — only that it terminates.
    const result = resolveFormDefaults(all, all, undefined, undefined);
    expect(result).toHaveLength(2);
  });
});
