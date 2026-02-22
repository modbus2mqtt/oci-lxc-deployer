// Frontend types: re-exports all shared types + frontend-specific extensions
export * from "./types";

// Frontend-only: Stack creation response
export interface ICreateStackResponse {
  success: boolean;
  key: string;
}

// Frontend-only: Docker-Compose migration warnings
export type ComposeWarningSeverity = "info" | "warning";
export type ComposeWarningCategory = "unsupported" | "partial" | "manual";

export interface IComposeWarning {
  id: string;
  severity: ComposeWarningSeverity;
  category: ComposeWarningCategory;
  feature: string;
  title: string;
  description: string; // Markdown formatted
  affectedServices?: string[];
}
