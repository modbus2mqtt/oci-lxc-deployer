import type { TestProject } from "vitest/node";
import {
  loadTemplateTestConfig,
  isTestHostReachable,
  getSkipReason,
} from "./template-test-config.mjs";

declare module "vitest" {
  export interface ProvidedContext {
    hostReachable: boolean;
  }
}

export default async function ({ provide }: TestProject) {
  const config = loadTemplateTestConfig();
  const reachable = await isTestHostReachable(config);
  provide("hostReachable", reachable);

  if (!reachable) {
    console.log(`\n  Template tests skipped: ${getSkipReason()}\n`);
  }
}
