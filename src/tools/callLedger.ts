import type { CanonicalToolCall } from "../api/canonical.js";
import { toolCallFingerprint } from "./toolParser.js";

export type CallStatus =
  | "proposed"
  | "exposed"
  | "result_received"
  | "succeeded"
  | "failed"
  | "interrupted";

export interface CallRecord {
  callId: string;
  actionId: string;
  planRevision: number;
  toolName: string;
  arguments: Record<string, unknown>;
  fingerprint: string;
  status: CallStatus;
  proposedAt: number;
  exposedAt?: number;
  resultReceivedAt?: number;
  completedAt?: number;
  interruptedAt?: number;
  resultIsError?: boolean;
}

export interface CallLedger {
  version: 2;
  calls: CallRecord[];
  updatedAt: number;
}

function normalizeArgumentValue(value: unknown): unknown {
  if (typeof value === "string") return value.normalize("NFC");
  if (Array.isArray(value)) return value.map(normalizeArgumentValue);
  if (value && typeof value === "object") {
    const result: Record<string, unknown> = Object.create(null) as Record<string, unknown>;
    for (const key of Object.keys(value).sort()) {
      result[key] = normalizeArgumentValue((value as Record<string, unknown>)[key]);
    }
    return result;
  }
  return value;
}

function normalizedArguments(arguments_: Record<string, unknown>): Record<string, unknown> {
  return normalizeArgumentValue(arguments_) as Record<string, unknown>;
}

export function createCallLedger(now = Date.now()): CallLedger {
  return { version: 2, calls: [], updatedAt: now };
}

export function findCallRecord(ledger: CallLedger, callId: string): CallRecord | undefined {
  return ledger.calls.find(call => call.callId === callId);
}

export function activeCallForAction(ledger: CallLedger, actionId: string): CallRecord | undefined {
  return [...ledger.calls].reverse().find(call => (
    call.actionId === actionId
    && (call.status === "proposed" || call.status === "exposed" || call.status === "result_received")
  ));
}

export function proposeCall(
  ledger: CallLedger,
  actionId: string,
  toolCall: CanonicalToolCall,
  now = Date.now(),
  planRevision = 0,
): CallRecord {
  if (findCallRecord(ledger, toolCall.id)) throw new Error("Call ID is already recorded.");
  if (activeCallForAction(ledger, actionId)) throw new Error("Action already has an active call.");
  const record: CallRecord = {
    callId: toolCall.id,
    actionId,
    planRevision,
    toolName: toolCall.name,
    arguments: normalizedArguments(toolCall.arguments),
    fingerprint: toolCallFingerprint(toolCall.name, toolCall.arguments),
    status: "proposed",
    proposedAt: now,
  };
  ledger.calls.push(record);
  ledger.updatedAt = now;
  return record;
}

export function markCallExposed(ledger: CallLedger, callId: string, now = Date.now()): boolean {
  const record = findCallRecord(ledger, callId);
  if (!record || record.status !== "proposed") return false;
  record.status = "exposed";
  record.exposedAt = now;
  ledger.updatedAt = now;
  return true;
}

export function recordCallResult(
  ledger: CallLedger,
  callId: string,
  isError: boolean,
  now = Date.now(),
): CallRecord | undefined {
  const record = findCallRecord(ledger, callId);
  if (!record || (record.status !== "exposed" && record.status !== "interrupted")) return undefined;
  record.status = "result_received";
  record.resultIsError = isError;
  record.resultReceivedAt = now;
  ledger.updatedAt = now;
  return record;
}

export function finalizeCall(
  ledger: CallLedger,
  callId: string,
  status: "succeeded" | "failed",
  now = Date.now(),
): boolean {
  const record = findCallRecord(ledger, callId);
  if (!record || record.status !== "result_received") return false;
  record.status = status;
  record.completedAt = now;
  ledger.updatedAt = now;
  return true;
}

export function interruptOpenCalls(ledger: CallLedger, now = Date.now()): string[] {
  const interrupted: string[] = [];
  for (const record of ledger.calls) {
    if (record.status !== "proposed" && record.status !== "exposed" && record.status !== "result_received") continue;
    record.status = "interrupted";
    record.interruptedAt = now;
    interrupted.push(record.callId);
  }
  if (interrupted.length > 0) ledger.updatedAt = now;
  return interrupted;
}

export function cloneCallLedger(ledger: CallLedger): CallLedger {
  return structuredClone(ledger);
}
