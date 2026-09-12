import { SESSION_MAX_CHARS, SESSION_MAX_ENTRIES } from "../config/constants.js";
import { BridgeError } from "../utils/errors.js";
import { isRecord } from "../utils/json.js";
import { cloneActionLedger, recoverRestoredActionLedger, type ActionLedger } from "../tools/actionLedger.js";
import { createCallLedger, type CallLedger, type CallRecord } from "../tools/callLedger.js";
import { createExecutionPlanState, type ExecutionPlanState } from "../tools/executionPlan.js";
import { createTaskPolicy, normalizeTaskPolicy } from "../tools/taskPolicy.js";
import type { PersistentSessionDocument } from "./persistentSessionDocument.js";

const ACTION_LEDGERS_SIBLING = "action_ledgers_v1";

export interface ChatEntry {
  role: "user" | "assistant";
  content: string;
  messageId?: number;
}

export interface UpstreamSessionState {
  chatSessionId: string | null;
  parentMessageId: number | null;
  history: ChatEntry[];
  actionLedger?: ActionLedger;
  updatedAt: number;
}

export class SessionStore {
  private readonly states = new Map<string, UpstreamSessionState>();
  private readonly maxEntries: number;
  private readonly maxChars: number;

  constructor(
    maxEntries = SESSION_MAX_ENTRIES,
    maxChars = SESSION_MAX_CHARS,
    private readonly document?: PersistentSessionDocument,
  ) {
    this.maxEntries = maxEntries;
    this.maxChars = maxChars;
  }

  async init(): Promise<void> {
    if (!this.document) return;
    const saved = this.document.getSibling(ACTION_LEDGERS_SIBLING);
    if (saved === undefined) return;
    if (!Array.isArray(saved)) throw persistenceError();
    for (const entry of saved) {
      if (!isRecord(entry) || typeof entry.upstreamKey !== "string") {
        throw persistenceError();
      }
      const normalized = normalizeActionLedger(entry.ledger);
      if (!normalized) throw persistenceError();
      const actionLedger = recoverRestoredActionLedger(normalized);
      this.states.set(entry.upstreamKey, {
        chatSessionId: null,
        parentMessageId: null,
        history: [],
        actionLedger,
        updatedAt: actionLedger.updatedAt,
      });
    }
  }

  async persistActionLedgers(): Promise<void> {
    if (!this.document) return;
    const ledgers = [...this.states]
      .filter((entry): entry is [string, UpstreamSessionState & { actionLedger: ActionLedger }] => Boolean(entry[1].actionLedger))
      .map(([upstreamKey, state]) => ({
        upstreamKey,
        ledger: cloneActionLedger(state.actionLedger),
      }));
    await this.document.replaceSibling(ACTION_LEDGERS_SIBLING, ledgers);
  }

  getOrCreate(key: string): UpstreamSessionState {
    let state = this.states.get(key);
    if (!state) {
      state = { chatSessionId: null, parentMessageId: null, history: [], updatedAt: 0 };
      this.states.set(key, state);
    }
    return state;
  }

  get(key: string): UpstreamSessionState | undefined {
    return this.states.get(key);
  }

  touch(state: UpstreamSessionState): void {
    state.updatedAt = Date.now();
  }

  reset(key: string): void {
    this.states.delete(key);
  }

  clear(): void {
    this.states.clear();
  }

  appendHistory(state: UpstreamSessionState, entry: ChatEntry): void {
    state.history.push(entry);
    this.enforceLimits(state);
  }

  private enforceLimits(state: UpstreamSessionState): void {
    if (state.history.length > this.maxEntries) {
      state.history.splice(0, state.history.length - this.maxEntries);
    }
    let total = 0;
    let cut = 0;
    for (let i = 0; i < state.history.length; i++) {
      const entry = state.history[i];
      if (!entry) continue;
      total += entry.content.length;
      if (total > this.maxChars) {
        cut = i + 1;
        break;
      }
    }
    if (cut > 0) {
      state.history.splice(0, cut);
      if (state.history.length === 0 && total > this.maxChars) {
        const last = state.history[0];
        if (last) state.history.push({ role: last.role, content: last.content.slice(-this.maxChars) });
      }
    }
  }

  prune(maxAgeMs: number): number {
    const now = Date.now();
    let removed = 0;
    for (const [key, state] of this.states) {
      if (now - state.updatedAt > maxAgeMs) {
        this.states.delete(key);
        removed++;
      }
    }
    return removed;
  }
}

function persistenceError(): BridgeError {
  return new BridgeError("Persistent action ledger is invalid.", {
    code: "PERSISTENCE_ERROR",
    status: 500,
  });
}

function stringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every(item => typeof item === "string");
}

function isCallStatus(value: unknown): value is CallRecord["status"] {
  return ["proposed", "exposed", "result_received", "succeeded", "failed", "interrupted"].includes(String(value));
}

function normalizeCallLedger(value: unknown, actionIds: Set<string>): CallLedger | undefined {
  if (!isRecord(value)
    || (value.version !== 1 && value.version !== 2)
    || typeof value.updatedAt !== "number"
    || !Number.isFinite(value.updatedAt)
    || !Array.isArray(value.calls)) return undefined;
  const callIds = new Set<string>();
  const calls: CallRecord[] = [];
  for (const call of value.calls) {
    if (!isRecord(call)
      || typeof call.callId !== "string"
      || typeof call.actionId !== "string"
      || !actionIds.has(call.actionId)
      || (value.version === 2 && call.planRevision === undefined)
      || (call.planRevision !== undefined && (!Number.isSafeInteger(call.planRevision) || (call.planRevision as number) < 0))
      || typeof call.toolName !== "string"
      || !isRecord(call.arguments)
      || typeof call.fingerprint !== "string"
      || !isCallStatus(call.status)
      || typeof call.proposedAt !== "number"
      || !Number.isFinite(call.proposedAt)
      || (call.exposedAt !== undefined && typeof call.exposedAt !== "number")
      || (call.resultReceivedAt !== undefined && typeof call.resultReceivedAt !== "number")
      || (call.completedAt !== undefined && typeof call.completedAt !== "number")
      || (call.interruptedAt !== undefined && typeof call.interruptedAt !== "number")
      || (call.resultIsError !== undefined && typeof call.resultIsError !== "boolean")
      || callIds.has(call.callId)) return undefined;
    callIds.add(call.callId);
    calls.push({
      callId: call.callId,
      actionId: call.actionId,
      planRevision: typeof call.planRevision === "number" ? call.planRevision : 0,
      toolName: call.toolName,
      arguments: structuredClone(call.arguments),
      fingerprint: call.fingerprint,
      status: call.status as CallRecord["status"],
      proposedAt: call.proposedAt,
      ...(typeof call.exposedAt === "number" ? { exposedAt: call.exposedAt } : {}),
      ...(typeof call.resultReceivedAt === "number" ? { resultReceivedAt: call.resultReceivedAt } : {}),
      ...(typeof call.completedAt === "number" ? { completedAt: call.completedAt } : {}),
      ...(typeof call.interruptedAt === "number" ? { interruptedAt: call.interruptedAt } : {}),
      ...(typeof call.resultIsError === "boolean" ? { resultIsError: call.resultIsError } : {}),
    });
  }
  return { version: 2, calls, updatedAt: value.updatedAt };
}

function normalizeExecutionPlan(value: unknown, updatedAt: number): ExecutionPlanState | undefined {
  if (value === undefined) return createExecutionPlanState(updatedAt);
  if (!isRecord(value)
    || value.version !== 1
    || !Number.isSafeInteger(value.revision)
    || (value.revision as number) < 0
    || typeof value.awaitingUpdate !== "boolean"
    || (value.discoveryCallId !== undefined && typeof value.discoveryCallId !== "string")
    || typeof value.updatedAt !== "number"
    || !Number.isFinite(value.updatedAt)) return undefined;
  return {
    version: 1,
    revision: value.revision as number,
    awaitingUpdate: value.awaitingUpdate,
    ...(typeof value.discoveryCallId === "string" ? { discoveryCallId: value.discoveryCallId } : {}),
    updatedAt: value.updatedAt,
  };
}

function normalizeActionLedger(value: unknown): ActionLedger | undefined {
  if (!isRecord(value)
    || (value.version !== 1 && value.version !== 2 && value.version !== 3 && value.version !== 4)
    || typeof value.turnKey !== "string"
    || (value.workspaceRoot !== undefined && typeof value.workspaceRoot !== "string")
    || typeof value.unresolvedIntent !== "boolean"
    || typeof value.updatedAt !== "number"
    || !Number.isFinite(value.updatedAt)
    || ((value.version === 3 || value.version === 4) && value.plan === undefined)
    || (value.version === 4 && value.taskPolicy === undefined)
    || !Array.isArray(value.actions)) return undefined;
  const ids = new Set<string>();
  const actions: ActionLedger["actions"] = [];
  for (const action of value.actions) {
    if (!isRecord(action)
      || typeof action.actionId !== "string"
      || typeof action.kind !== "string"
      || (action.operation !== undefined && !["create", "edit", "delete", "verify"].includes(String(action.operation)))
      || (action.target !== undefined && typeof action.target !== "string")
      || !stringArray(action.expectedValues)
      || (action.resultValues !== undefined && !stringArray(action.resultValues))
      || !stringArray(action.dependencies)
      || !stringArray(action.requiredToolNames)
      || typeof action.mandatory !== "boolean"
      || !["pending", "running", "succeeded", "failed", "stale"].includes(String(action.status))
      || (action.callId !== undefined && typeof action.callId !== "string")
      || (action.toolFingerprint !== undefined && typeof action.toolFingerprint !== "string")
      || !stringArray(action.failedFingerprints)
      || (action.source !== undefined && action.source !== "inferred" && action.source !== "plan")
      || (action.description !== undefined && typeof action.description !== "string")
      || (action.planKind !== undefined && !["discovery", "mutation", "verification", "validation", "action"].includes(String(action.planKind)))
      || (action.createdRevision !== undefined && (!Number.isSafeInteger(action.createdRevision) || (action.createdRevision as number) < 0))
      || (action.expectedArguments !== undefined && !isRecord(action.expectedArguments))
      || (action.opensDiscovery !== undefined && typeof action.opensDiscovery !== "boolean")
      || (action.evidenceCallIds !== undefined && !stringArray(action.evidenceCallIds))
      || ((value.version === 3 || value.version === 4) && (
        action.source === undefined
        || typeof action.description !== "string"
        || action.createdRevision === undefined
        || typeof action.opensDiscovery !== "boolean"
        || !stringArray(action.evidenceCallIds)
      ))
      || (action.source === "plan" && (
        typeof action.description !== "string"
        || action.planKind === undefined
        || action.createdRevision === undefined
        || !isRecord(action.expectedArguments)
        || typeof action.opensDiscovery !== "boolean"
        || !stringArray(action.evidenceCallIds)
        || action.requiredToolNames.length === 0
        || action.mandatory !== true
      ))
      || ids.has(action.actionId)) return undefined;
    ids.add(action.actionId);
    actions.push({
      actionId: action.actionId,
      kind: action.kind as ActionLedger["actions"][number]["kind"],
      ...(action.operation !== undefined ? { operation: action.operation as ActionLedger["actions"][number]["operation"] } : {}),
      ...(action.target !== undefined ? { target: action.target } : {}),
      expectedValues: [...action.expectedValues],
      ...(action.resultValues !== undefined ? { resultValues: [...action.resultValues] } : {}),
      dependencies: [...action.dependencies],
      requiredToolNames: [...action.requiredToolNames],
      mandatory: action.mandatory,
      status: action.status as ActionLedger["actions"][number]["status"],
      failedFingerprints: [...action.failedFingerprints],
      source: action.source === "plan" ? "plan" : "inferred",
      description: typeof action.description === "string" ? action.description : String(action.kind),
      ...(action.planKind !== undefined ? { planKind: action.planKind as ActionLedger["actions"][number]["planKind"] } : {}),
      createdRevision: typeof action.createdRevision === "number" ? action.createdRevision : 0,
      ...(isRecord(action.expectedArguments) ? { expectedArguments: structuredClone(action.expectedArguments) } : {}),
      opensDiscovery: action.opensDiscovery === true,
      evidenceCallIds: stringArray(action.evidenceCallIds) ? [...action.evidenceCallIds] : [],
    });
  }
  if (!actions.every(action => action.dependencies.every(dependency => ids.has(dependency)))) return undefined;

  let callLedger: CallLedger;
  if (value.version === 2 || value.version === 3 || value.version === 4) {
    const normalizedCallLedger = normalizeCallLedger(value.callLedger, ids);
    if (!normalizedCallLedger) return undefined;
    callLedger = normalizedCallLedger;
  } else {
    if (!isRecord(value.callToAction)
      || !Object.values(value.callToAction).every(item => typeof item === "string" && ids.has(item))) return undefined;
    callLedger = createCallLedger(value.updatedAt);
    for (const [callId, actionId] of Object.entries(value.callToAction) as Array<[string, string]>) {
      const legacy = value.actions.find(candidate => isRecord(candidate) && candidate.actionId === actionId) as Record<string, unknown> | undefined;
      const isCurrent = legacy?.callId === callId;
      const status: CallRecord["status"] = isCurrent && legacy?.status === "running"
        ? "exposed"
        : isCurrent && legacy?.status === "succeeded"
          ? "succeeded"
          : isCurrent && legacy?.status === "failed"
            ? "failed"
            : "interrupted";
      callLedger.calls.push({
        callId,
        actionId,
        planRevision: 0,
        toolName: "legacy",
        arguments: {},
        fingerprint: typeof legacy?.toolFingerprint === "string" ? legacy.toolFingerprint : `legacy:${callId}`,
        status,
        proposedAt: value.updatedAt,
        ...(status !== "interrupted" ? { exposedAt: value.updatedAt } : { interruptedAt: value.updatedAt }),
        ...(status === "succeeded" || status === "failed"
          ? { resultReceivedAt: value.updatedAt, completedAt: value.updatedAt }
          : {}),
      });
    }
  }
  const plan = normalizeExecutionPlan(value.plan, value.updatedAt);
  if (!plan) return undefined;
  const workspaceRoot = typeof value.workspaceRoot === "string" ? value.workspaceRoot : undefined;
  const legacyDiscoveryEvidence = value.version === 4
    && isRecord(value.taskPolicy)
    && value.taskPolicy.mutationScope === "workspace"
    && value.taskPolicy.mutationTargetsRequireDiscoveryEvidence === undefined;
  const taskPolicy = value.version === 4
    ? normalizeTaskPolicy(value.taskPolicy)
    : createTaskPolicy(
        actions,
        [...new Set(actions.flatMap(action => action.requiredToolNames))],
        workspaceRoot,
        value.unresolvedIntent,
        value.updatedAt,
      );
  if (!taskPolicy || taskPolicy.workspaceRoot !== workspaceRoot) return undefined;
  if (legacyDiscoveryEvidence && taskPolicy.mutationTargetsRequireDiscoveryEvidence) {
    for (const action of actions) {
      if (action.opensDiscovery) action.resultValues = [];
    }
  }
  if (actions.some(action => action.createdRevision > plan.revision)
    || callLedger.calls.some(call => call.planRevision > plan.revision)) return undefined;
  const callsById = new Map(callLedger.calls.map(call => [call.callId, call]));
  if (actions.some(action => action.evidenceCallIds.some(callId => {
    const call = callsById.get(callId);
    return !call || call.actionId !== action.actionId || (call.status !== "succeeded" && call.status !== "failed");
  }))) return undefined;
  if (plan.awaitingUpdate) {
    const discoveryCall = plan.discoveryCallId ? callsById.get(plan.discoveryCallId) : undefined;
    if (!discoveryCall || discoveryCall.status !== "succeeded") return undefined;
  } else if (plan.discoveryCallId !== undefined) {
    return undefined;
  }
  return {
    version: 4,
    turnKey: value.turnKey,
    ...(typeof value.workspaceRoot === "string" ? { workspaceRoot: value.workspaceRoot } : {}),
    actions,
    unresolvedIntent: value.unresolvedIntent,
    callLedger,
    plan,
    taskPolicy,
    updatedAt: value.updatedAt,
  };
}
