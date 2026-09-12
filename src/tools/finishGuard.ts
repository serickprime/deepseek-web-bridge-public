import type { ActionLedger } from "./actionLedger.js";
import { findCallRecord } from "./callLedger.js";
import type { StrictBridgeTurn } from "./toolParser.js";

export type StrictFinish = Extract<StrictBridgeTurn, { type: "finish" }>;

export interface FinishGuardDecision {
  allowed: boolean;
  reason:
    | "complete"
    | "blocked_after_failure"
    | "ledger_incomplete"
    | "plan_update_required"
    | "missing_evidence"
    | "unknown_evidence"
    | "nonterminal_evidence"
    | "no_failed_action"
    | "call_still_running";
}

function hasOpenCall(ledger: ActionLedger): boolean {
  return ledger.callLedger.calls.some(call => (
    call.status === "proposed"
    || call.status === "exposed"
    || call.status === "result_received"
  ));
}

export function evaluateFinish(ledger: ActionLedger, finish: StrictFinish): FinishGuardDecision {
  if (hasOpenCall(ledger) || ledger.actions.some(action => action.status === "running")) {
    return { allowed: false, reason: "call_still_running" };
  }
  if (ledger.plan.awaitingUpdate) return { allowed: false, reason: "plan_update_required" };

  const referenced = finish.evidenceCallIds.map(callId => findCallRecord(ledger.callLedger, callId));
  if (referenced.some(call => call === undefined)) return { allowed: false, reason: "unknown_evidence" };

  if (finish.status === "blocked") {
    if (referenced.some(call => call!.status !== "succeeded" && call!.status !== "failed")) {
      return { allowed: false, reason: "nonterminal_evidence" };
    }
    const failedActionIds = new Set(ledger.actions.filter(action => action.mandatory && action.status === "failed").map(action => action.actionId));
    if (failedActionIds.size === 0
      || !referenced.some(call => failedActionIds.has(call!.actionId))) {
      return { allowed: false, reason: "no_failed_action" };
    }
    return { allowed: true, reason: "blocked_after_failure" };
  }

  if (ledger.unresolvedIntent || ledger.actions.some(action => action.mandatory && action.status !== "succeeded")) {
    return { allowed: false, reason: "ledger_incomplete" };
  }
  if (referenced.some(call => call!.status !== "succeeded")) {
    return { allowed: false, reason: "nonterminal_evidence" };
  }
  const evidenceActionIds = new Set(referenced.map(call => call!.actionId));
  if (ledger.actions.some(action => action.mandatory && !evidenceActionIds.has(action.actionId))) {
    return { allowed: false, reason: "missing_evidence" };
  }
  return { allowed: true, reason: "complete" };
}

export function successfulLedgerCallIds(ledger: ActionLedger): string[] {
  const succeededActionIds = new Set(ledger.actions.filter(action => action.status === "succeeded").map(action => action.actionId));
  return ledger.callLedger.calls
    .filter(call => call.status === "succeeded" && succeededActionIds.has(call.actionId))
    .map(call => call.callId);
}

export function failedLedgerCallIds(ledger: ActionLedger): string[] {
  const failedActionIds = new Set(ledger.actions.filter(action => action.status === "failed").map(action => action.actionId));
  return ledger.callLedger.calls
    .filter(call => (call.status === "succeeded" || call.status === "failed") && failedActionIds.has(call.actionId))
    .map(call => call.callId);
}
