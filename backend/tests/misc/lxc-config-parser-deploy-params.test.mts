import { describe, it, expect } from "vitest";
import { spawnSync } from "child_process";
import fs from "node:fs";
import path from "node:path";

/**
 * Verifies that lxc_config_parser_lib.py extracts the `proxvex:deploy-params`
 * base64 snapshot marker — including from the URL-encoded form PVE stores in
 * the description (base64 `+` `/` `=` become %2B %2F %3D). The base64 is kept
 * raw; decoding happens TS-side (WebAppVeParameterProcessor.decodeDeployParams).
 */
function parseLxcConfig(confText: string): Record<string, unknown> {
  const repoRoot = path.resolve(import.meta.dirname, "../../..");
  const libPath = path.join(
    repoRoot,
    "json/shared/scripts/library/lxc_config_parser_lib.py",
  );
  if (!fs.existsSync(libPath)) {
    throw new Error(`lxc_config_parser_lib.py not found at ${libPath}`);
  }
  const runner = `
import sys
sys.path.insert(0, "${path.dirname(libPath)}")
from lxc_config_parser_lib import parse_lxc_config
import json
config = parse_lxc_config(sys.stdin.read())
print(json.dumps(config.to_dict()))
`;
  const result = spawnSync("python3", ["-c", runner], {
    input: confText,
    encoding: "utf8",
  });
  if (result.status !== 0) {
    throw new Error(`python3 failed: ${result.stderr || result.stdout}`);
  }
  return JSON.parse(result.stdout);
}

// A snapshot whose base64 deliberately contains +, / and = so the URL-encoding
// round-trip is exercised.
const SNAPSHOT = {
  v: 1,
  params: [
    { name: "memory", value: 2048 },
    { name: "local_https_port", value: "3443" },
  ],
  selectedAddons: ["addon-ssl", "addon-oidc"],
};
const B64 = Buffer.from(JSON.stringify(SNAPSHOT)).toString("base64");

function plainNote(b64: string): string {
  return `<!-- proxvex:managed -->
<!-- proxvex:deploy-params data:application/json;base64,${b64} -->
<!-- proxvex:application-id modbus2mqtt -->
arch: amd64
hostname: modbus2mqtt-ssl
memory: 2048
`;
}

// Mimic PVE description encoding: ':' -> %3A, '+' -> %2B, '=' -> %3D, each
// marker line prefixed with '#'. ('/' is left as-is, matching real PVE notes.)
function encodedNote(b64: string): string {
  const enc = b64.replace(/\+/g, "%2B").replace(/=/g, "%3D");
  return `#<!-- proxvex%3Amanaged -->
#<!-- proxvex%3Adeploy-params data%3Aapplication/json;base64,${enc} -->
#<!-- proxvex%3Aapplication-id modbus2mqtt -->
arch: amd64
hostname: modbus2mqtt-ssl
memory: 2048
`;
}

describe("lxc_config_parser_lib — deploy-params marker", () => {
  it("extracts the base64 snapshot from a plain note and it decodes back", () => {
    const config = parseLxcConfig(plainNote(B64));
    expect(config.deploy_params_b64).toBe(B64);
    const decoded = JSON.parse(
      Buffer.from(config.deploy_params_b64 as string, "base64").toString("utf8"),
    );
    expect(decoded).toEqual(SNAPSHOT);
  });

  it("extracts the base64 snapshot from a URL-encoded (PVE-stored) note", () => {
    const config = parseLxcConfig(encodedNote(B64));
    expect(config.deploy_params_b64).toBe(B64);
  });

  it("leaves deploy_params_b64 absent when the marker is not present", () => {
    const config = parseLxcConfig(
      "<!-- proxvex:managed -->\nhostname: x\nmemory: 512\n",
    );
    expect(config.is_managed).toBe(true);
    expect(config.deploy_params_b64).toBeUndefined();
  });
});
