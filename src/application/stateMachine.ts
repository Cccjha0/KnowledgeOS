import { PkbError } from "../core/errors.js";

export type ApplicationStatus =
  | "watching"
  | "not-open"
  | "open"
  | "preparing"
  | "submitted"
  | "awaiting-result"
  | "conditional-offer"
  | "unconditional-offer"
  | "accepted"
  | "coe-issued"
  | "visa-processing"
  | "completed"
  | "rejected"
  | "withdrawn"
  | "archived";

export interface ApplicationStateRule {
  entersFrom: Array<ApplicationStatus | "initial">;
  tasks: string[];
  stopMonitoring: string[];
  today: string | null;
  userConfirmation: boolean;
  terminal: boolean;
}

const ACTIVE_BEFORE_SUBMISSION: ApplicationStatus[] = ["watching", "not-open", "open", "preparing"];
const ACTIVE_AFTER_SUBMISSION: ApplicationStatus[] = [
  "submitted", "awaiting-result", "conditional-offer", "unconditional-offer", "accepted", "coe-issued", "visa-processing",
];

export const APPLICATION_STATE_MACHINE: Record<ApplicationStatus, ApplicationStateRule> = {
  watching: { entersFrom: ["initial"], tasks: ["schedule-opening-check"], stopMonitoring: [], today: "等待申请周期开放", userConfirmation: true, terminal: false },
  "not-open": { entersFrom: ["watching", "open"], tasks: ["schedule-opening-check"], stopMonitoring: [], today: "申请尚未开放，等待下次核验", userConfirmation: true, terminal: false },
  open: { entersFrom: ["watching", "not-open"], tasks: ["start-material-checklist"], stopMonitoring: [], today: "申请已开放，开始准备材料", userConfirmation: true, terminal: false },
  preparing: { entersFrom: ["open"], tasks: ["complete-required-documents", "confirm-deadline"], stopMonitoring: [], today: "Prepare missing application documents", userConfirmation: true, terminal: false },
  submitted: { entersFrom: ["preparing"], tasks: ["confirm-submitted-at", "save-submission-receipt"], stopMonitoring: ["application-opening", "requirements"], today: "Confirm submission evidence and wait for acknowledgement", userConfirmation: true, terminal: false },
  "awaiting-result": { entersFrom: ["submitted"], tasks: ["monitor-application-result"], stopMonitoring: ["application-opening", "requirements"], today: "Monitor the application result", userConfirmation: true, terminal: false },
  "conditional-offer": { entersFrom: ["awaiting-result"], tasks: ["review-offer-conditions"], stopMonitoring: ["application-opening", "requirements"], today: "Review and satisfy offer conditions", userConfirmation: true, terminal: false },
  "unconditional-offer": { entersFrom: ["awaiting-result", "conditional-offer"], tasks: ["review-offer", "decide-offer"], stopMonitoring: ["application-opening", "requirements", "result"], today: "Decide whether to accept the offer", userConfirmation: true, terminal: false },
  accepted: { entersFrom: ["conditional-offer", "unconditional-offer"], tasks: ["confirm-deposit", "prepare-coe"], stopMonitoring: ["application-opening", "requirements", "result"], today: "Complete deposit and COE steps", userConfirmation: true, terminal: false },
  "coe-issued": { entersFrom: ["accepted"], tasks: ["prepare-visa-application"], stopMonitoring: ["application-opening", "requirements", "result", "offer"], today: "Prepare the visa application", userConfirmation: true, terminal: false },
  "visa-processing": { entersFrom: ["coe-issued"], tasks: ["monitor-visa-result"], stopMonitoring: ["application-opening", "requirements", "result", "offer"], today: "Monitor the visa result", userConfirmation: true, terminal: false },
  completed: { entersFrom: ["visa-processing"], tasks: [], stopMonitoring: ["all"], today: null, userConfirmation: true, terminal: true },
  rejected: { entersFrom: ["awaiting-result", "conditional-offer"], tasks: ["record-rejection", "consider-alternatives"], stopMonitoring: ["all"], today: "Record the result and consider alternatives", userConfirmation: true, terminal: true },
  withdrawn: { entersFrom: [...ACTIVE_BEFORE_SUBMISSION, ...ACTIVE_AFTER_SUBMISSION], tasks: ["record-withdrawal"], stopMonitoring: ["all"], today: null, userConfirmation: true, terminal: true },
  archived: { entersFrom: ["completed", "rejected", "withdrawn"], tasks: [], stopMonitoring: ["all"], today: null, userConfirmation: true, terminal: true },
};

export function assertApplicationTransition(from: ApplicationStatus, to: ApplicationStatus): void {
  if (!APPLICATION_STATE_MACHINE[to].entersFrom.includes(from)) {
    throw new PkbError("INVALID_APPLICATION_TRANSITION", `Application status cannot move from ${from} to ${to}.`, { from, to });
  }
}
