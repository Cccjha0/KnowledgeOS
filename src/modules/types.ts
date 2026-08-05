import type { JsonObject } from "../core/types.js";

export type ModuleTemplate = "minimal-config" | "workflow" | "integration";
export type ModuleMaturity = "experimental" | "beta" | "stable" | "deprecated";
export type ValidationStatus = "pass" | "warning" | "fail";

export interface ModuleValidationCheck extends JsonObject {
  category: "manifest" | "compatibility" | "schema" | "references" | "permissions" | "contracts" | "behavior" | "prompt-regression" | "lifecycle" | "migration" | "documentation" | "events";
  code: string;
  status: ValidationStatus;
  message: string;
  critical: boolean;
  path: string | null;
}

export interface ModuleValidationReport extends JsonObject {
  report_version: 1;
  module_id: string;
  module_version: string;
  maturity: ModuleMaturity;
  generated_at: string;
  checks: ModuleValidationCheck[];
  counts: JsonObject;
  overall: "PASS" | "PASS WITH WARNINGS" | "FAIL";
  beta_eligible: boolean;
  stable_eligible: boolean;
}

export interface ModuleTestCheck extends JsonObject {
  category: "capture" | "ambiguous" | "idempotency" | "permission" | "lifecycle" | "periodic" | "event" | "resource" | "prompt-regression" | "migration";
  status: "pass" | "fail" | "not-applicable";
  message: string;
  details: JsonObject | null;
}

export interface ModuleTestReport extends JsonObject {
  report_version: 1;
  module_id: string;
  module_version: string;
  generated_at: string;
  static_validation: ModuleValidationReport;
  checks: ModuleTestCheck[];
  overall: "PASS" | "FAIL";
  beta_eligible: boolean;
}

export interface ModuleLockEntry extends JsonObject {
  version: string;
  checksum: string;
  installed_at: string;
  source: string;
  installed_path: string;
  previous_version: string | null;
  validation_report: string;
}
