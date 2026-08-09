import { createHash } from "node:crypto";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { PkbError } from "../core/errors.js";
import type { JsonObject, JsonValue } from "../core/types.js";
import { executeCodexJson } from "../runtime/codexCli.js";
import { getModuleBuilderPlatformContract, moduleBuilderContractReference, type ModuleBuilderPlatformContract } from "./platformContract.js";

const ENGINE_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");

export type GuidedBoundary = "module" | "component" | "configuration-pack" | "instance" | "capability-gap";

export interface GuidedBuilderQuestion extends JsonObject {
  id: string;
  category: "network" | "content-access" | "user-content" | "destructive" | "global-events" | "critical-fields";
  question: string;
  impact: string;
}

export interface GuidedBuilderAnalysis extends JsonObject {
  analysis_version: 1;
  requirement_hash: string;
  boundary: { kind: GuidedBoundary; rationale: string; exclusions: string[] };
  summary: string;
  questions: GuidedBuilderQuestion[];
  proposed_blueprint: JsonObject | null;
  capability_gap: JsonObject | null;
  platform_contract: JsonObject | null;
  generated_at: string;
}

const MODULE_BUILDER_INSTRUCTIONS = `
KnowledgeOS Module Builder contract:
- First classify the request as exactly one of module, component, configuration-pack, instance, or capability-gap.
- A Module needs independent entities, lifecycle, permissions, and an instance boundary. A Component is stateless and shared. A Configuration Pack varies policy within an existing module. An Instance is one concrete use of an existing module.
- Modules only declare schemas, prompts, workflows, rules, templates, jobs, events, dashboard items and fixtures. They never contain custom executors or direct file/Git writes.
- Separate sensitivity_class (0 public to 3 highly sensitive) from read representation (metadata, summary, full, sensitive-original). Unclassified attachments are metadata-only. A summary must be explicit, never a copied first paragraph.
- Ask for confirmation, never silently enable: network, full/sensitive reads, mutable user originals, destructive behaviour, global event subscriptions, or critical fields.
- If the platform cannot express a real requirement, report a capability gap; do not invent a Step, Adapter, Pack, Component, or operation.
- Return only valid JSON. The proposed_blueprint must be complete and compatible with the supplied Blueprint Schema when boundary.kind is module. Do not include a proposed blueprint for any other boundary kind.
`;


function object(value: unknown): JsonObject | null {
  return value && typeof value === "object" && !Array.isArray(value) ? value as JsonObject : null;
}

function strings(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string" && item.trim().length > 0) : [];
}

function questions(value: unknown): GuidedBuilderQuestion[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((item) => {
    const candidate = object(item);
    const category = candidate?.category;
    if (!candidate || typeof candidate.id !== "string" || typeof candidate.question !== "string" || typeof candidate.impact !== "string"
      || !["network", "content-access", "user-content", "destructive", "global-events", "critical-fields"].includes(String(category))) return [];
    return [{ id: candidate.id, category: category as GuidedBuilderQuestion["category"], question: candidate.question, impact: candidate.impact }];
  });
}

function requirementHash(brief: string): string {
  return createHash("sha256").update(brief.trim(), "utf8").digest("hex");
}

/** Validates untrusted model output before the command API exposes it to UI. */
export function normalizeGuidedBuilderAnalysis(brief: string, raw: unknown, contract: ModuleBuilderPlatformContract | null = null): GuidedBuilderAnalysis {
  const value = object(raw);
  const boundary = object(value?.boundary);
  const kind = String(boundary?.kind ?? "");
  if (!value || !["module", "component", "configuration-pack", "instance", "capability-gap"].includes(kind)) {
    throw new PkbError("GUIDED_BUILDER_INVALID_OUTPUT", "Codex did not return a supported extension boundary. Please try again.");
  }
  const proposed = object(value.proposed_blueprint);
  if (kind === "module" && !proposed) throw new PkbError("GUIDED_BUILDER_INVALID_OUTPUT", "Codex classified this as a module but did not provide a Blueprint.");
  if (kind !== "module" && proposed) throw new PkbError("GUIDED_BUILDER_INVALID_OUTPUT", "Only a module decision may contain a Module Blueprint.");
  const capabilityGap = object(value.capability_gap);
  if (kind === "capability-gap" && !capabilityGap) throw new PkbError("GUIDED_BUILDER_INVALID_OUTPUT", "A capability-gap decision must explain the missing generic contract.");
  return {
    analysis_version: 1,
    requirement_hash: requirementHash(brief),
    boundary: {
      kind: kind as GuidedBoundary,
      rationale: typeof boundary?.rationale === "string" ? boundary.rationale : "No rationale was supplied.",
      exclusions: strings(boundary?.exclusions),
    },
    summary: typeof value.summary === "string" ? value.summary : brief.trim(),
    questions: questions(value.questions),
    proposed_blueprint: proposed,
    capability_gap: capabilityGap,
    platform_contract: contract ? moduleBuilderContractReference(contract) : null,
    generated_at: new Date().toISOString(),
  };
}


function promptForPlatformContract(brief: string, contract: ModuleBuilderPlatformContract): string {
  return `${MODULE_BUILDER_INSTRUCTIONS}\n\nRead module-builder-platform-contract.json. It is the authoritative list of the Blueprint Schema, Capability Packs, Adapters, Components, Workflow Steps, and Engine API that you may use. Do not invent identifiers outside that contract.\n\nContract reference: ${JSON.stringify(moduleBuilderContractReference(contract))}\n\nUser requirement:\n${brief.trim()}\n\nReturn exactly this JSON shape:\n{\n  "boundary": { "kind": "module|component|configuration-pack|instance|capability-gap", "rationale": "...", "exclusions": ["..."] },\n  "summary": "...",\n  "questions": [{ "id": "stable-id", "category": "network|content-access|user-content|destructive|global-events|critical-fields", "question": "a decision the user must make", "impact": "why it matters" }],\n  "proposed_blueprint": { "complete Blueprint compatible with the supplied Blueprint Schema" } | null,\n  "capability_gap": { "requested_behavior": "...", "why_existing_platform_cannot_express_it": "...", "affected_modules": ["..."], "proposed_generic_contract": "...", "privacy_and_permission_impact": "...", "acceptance_tests": ["..."] } | null\n}\nDo not use markdown fences. Keep questions empty unless the choice changes ownership, privacy, side effects, or user experience.`;
}


export async function analyzeGuidedModuleRequirement(options: {
  brief: string;
  engineRoot?: string;
  codexModel?: string;
  codexReasoningEffort?: string;
  execute?: typeof executeCodexJson;
}): Promise<GuidedBuilderAnalysis> {
  const brief = options.brief.trim();
  if (brief.length < 20) throw new PkbError("GUIDED_BUILDER_BRIEF_TOO_SHORT", "Describe the normal input, output, and daily use in at least 20 characters.");
  const contract = await getModuleBuilderPlatformContract(options.engineRoot ?? ENGINE_ROOT);
  const contextRoot = await fs.mkdtemp(path.join(os.tmpdir(), "knowledgeos-guided-builder-"));
  try {
    await fs.writeFile(path.join(contextRoot, "requirement.md"), brief, "utf8");
    await fs.writeFile(path.join(contextRoot, "module-builder-contract.md"), MODULE_BUILDER_INSTRUCTIONS.trim(), "utf8");
    await fs.writeFile(path.join(contextRoot, "module-builder-platform-contract.json"), JSON.stringify(contract, null, 2), "utf8");
    const result = await (options.execute ?? executeCodexJson)({
      contextRoot,
      prompt: promptForPlatformContract(brief, contract),
      model: options.codexModel,
      reasoningEffort: options.codexReasoningEffort,
      timeoutMs: 120_000,
    });
    return normalizeGuidedBuilderAnalysis(brief, result.output, contract);
  } finally {
    await fs.rm(contextRoot, { recursive: true, force: true });
  }
}
