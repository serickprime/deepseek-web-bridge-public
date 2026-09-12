import path from "node:path";
import type { CanonicalTool, CanonicalToolCall } from "../api/canonical.js";
import type { GenericToolRuntimeMode } from "../config/env.js";
import type { LedgerAction } from "./actionLedger.js";
import {
  authorizeExecutionPlan,
  resolveTaskPolicyPath,
  type TaskPolicy,
  type TaskPolicyDecision,
  type TaskPolicyPlanStep,
} from "./taskPolicy.js";
import {
  matchesToolInputSchema,
  matchesToolInputSchemaConstraints,
  type StrictPlanStep,
} from "./toolParser.js";

export type PlanStepKind = "discovery" | "mutation" | "verification" | "validation" | "action";

export interface ExecutionPlanState {
  version: 1;
  revision: number;
  awaitingUpdate: boolean;
  discoveryCallId?: string;
  updatedAt: number;
}

export interface PlanUpdateDecision {
  allowed: boolean;
  reason:
    | "applied"
    | "replayed"
    | "not_expected"
    | "revision_conflict"
    | "unknown_dependency"
    | "cyclic_dependency"
    | "duplicate_step"
    | "server_state_forbidden"
    | "optional_step"
    | "unknown_tool"
    | "unsafe_arguments"
    | "input_schema_mismatch"
    | "tool_kind_mismatch"
    | "missing_fresh_verification"
    | "duplicate_mutation"
    | "duplicate_succeeded_mutation"
    | "too_many_steps"
    | "empty_initial_plan"
    | "next_tool_required"
    | "next_tool_not_admissible"
    | "shadow_only"
    | Exclude<TaskPolicyDecision["reason"], "allowed">;
  revision?: number;
}

export interface PlanUpdateRolloutDecision {
  decision: PlanUpdateDecision;
  mode: GenericToolRuntimeMode;
  applied: boolean;
  shadowDecision?: PlanUpdateDecision;
}

export interface PlanLedgerView {
  workspaceRoot?: string;
  actions: LedgerAction[];
  unresolvedIntent: boolean;
  plan: ExecutionPlanState;
  callLedger: { calls: Array<{ status: string }> };
  taskPolicy: TaskPolicy;
  updatedAt: number;
}

export function initialExecutionPlanRequired(ledger: PlanLedgerView): boolean {
  return ledger.unresolvedIntent
    && ledger.plan.revision === 0
    && ledger.callLedger.calls.length === 0
    && ledger.actions.every(action => action.source === "inferred" && action.status === "pending");
}

export function prepareExecutionPlanAuthority(
  ledger: PlanLedgerView,
  mode: GenericToolRuntimeMode,
  now = Date.now(),
): void {
  if (mode !== "enabled" || ledger.plan.revision !== 0 || ledger.callLedger.calls.length > 0) return;
  if (ledger.actions.some(action => action.status !== "pending" || action.source !== "inferred")) return;
  const externalActionRequested = ledger.unresolvedIntent || ledger.actions.length > 0;
  if (!externalActionRequested) return;
  ledger.unresolvedIntent = true;
  ledger.updatedAt = now;
}

const PATH_KEYS = new Set(["file", "filename", "file_path", "path", "directory", "cwd"]);
const DANGEROUS_KEYS = new Set(["__proto__", "prototype", "constructor"]);
const MAX_PLAN_ACTIONS = 256;

export function createExecutionPlanState(now = Date.now()): ExecutionPlanState {
  return { version: 1, revision: 0, awaitingUpdate: false, updatedAt: now };
}

function normalizedText(value: string): string {
  return value.normalize("NFC");
}

function isWindowsPath(value: string): boolean {
  return /^[a-z]:[\\/]/i.test(value) || /^\\\\/.test(value);
}

function pathApi(value: string): typeof path.posix {
  return isWindowsPath(value) ? path.win32 : path.posix;
}

function resolvedWorkspacePath(workspaceRoot: string | undefined, value: string): string | undefined {
  const normalizedValue = normalizedText(value).trim();
  if (!workspaceRoot) return undefined;
  const api = pathApi(workspaceRoot);
  const root = api.resolve(workspaceRoot);
  const resolved = api.resolve(root, normalizedValue);
  const relative = api.relative(root, resolved);
  if (relative === ".." || relative.startsWith(`..${api.sep}`) || api.isAbsolute(relative)) return undefined;
  const normalized = api.normalize(resolved);
  return api === path.win32 ? normalized.toLowerCase() : normalized;
}

function promptWorkspaceTarget(workspaceRoot: string | undefined, target: string): string {
  const resolved = resolveTaskPolicyPath(workspaceRoot, target);
  if (!workspaceRoot || !resolved) return target;
  const api = pathApi(workspaceRoot);
  const relative = api.relative(api.resolve(workspaceRoot), resolved);
  return relative || ".";
}

function safeJsonValue(value: unknown, depth = 0): boolean {
  if (depth > 32) return false;
  if (value === null || typeof value === "string" || typeof value === "boolean") return true;
  if (typeof value === "number") return Number.isFinite(value);
  if (Array.isArray(value)) return value.every(item => safeJsonValue(item, depth + 1));
  if (!value || typeof value !== "object") return false;
  for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
    if (DANGEROUS_KEYS.has(key) || !safeJsonValue(item, depth + 1)) return false;
  }
  return true;
}

function pathArgumentsStayInWorkspace(
  workspaceRoot: string | undefined,
  value: unknown,
  key = "",
): boolean {
  if (typeof value === "string") {
    return !PATH_KEYS.has(key.toLowerCase()) || resolvedWorkspacePath(workspaceRoot, value) !== undefined;
  }
  if (Array.isArray(value)) return value.every(item => pathArgumentsStayInWorkspace(workspaceRoot, item, key));
  if (!value || typeof value !== "object") return true;
  return Object.entries(value as Record<string, unknown>)
    .every(([nestedKey, item]) => pathArgumentsStayInWorkspace(workspaceRoot, item, nestedKey));
}

function expectedValueMatches(
  workspaceRoot: string | undefined,
  key: string,
  expected: unknown,
  actual: unknown,
): boolean {
  if (typeof expected === "string") {
    if (typeof actual !== "string") return false;
    if (PATH_KEYS.has(key.toLowerCase())) {
      const left = resolvedWorkspacePath(workspaceRoot, expected);
      const right = resolvedWorkspacePath(workspaceRoot, actual);
      return Boolean(left && right && left === right);
    }
    return normalizedText(actual) === normalizedText(expected);
  }
  if (Array.isArray(expected)) {
    return Array.isArray(actual)
      && expected.length === actual.length
      && expected.every((item, index) => expectedValueMatches(workspaceRoot, key, item, actual[index]));
  }
  if (expected && typeof expected === "object") {
    if (!actual || typeof actual !== "object" || Array.isArray(actual)) return false;
    const expectedEntries = Object.entries(expected as Record<string, unknown>);
    if (Object.keys(actual as Record<string, unknown>).length !== expectedEntries.length) return false;
    return expectedEntries.every(([nestedKey, item]) => (
      Object.prototype.hasOwnProperty.call(actual, nestedKey)
      && expectedValueMatches(workspaceRoot, nestedKey, item, (actual as Record<string, unknown>)[nestedKey])
    ));
  }
  return Object.is(expected, actual);
}

function expectedArgumentsEqual(
  workspaceRoot: string | undefined,
  left: Record<string, unknown>,
  right: Record<string, unknown>,
): boolean {
  return expectedValueMatches(workspaceRoot, "", left, right);
}

function sameStringSet(left: readonly string[], right: readonly string[], normalize = false): boolean {
  if (left.length !== right.length) return false;
  const normalizedLeft = left.map(value => normalize ? value.toLowerCase() : value).sort();
  const normalizedRight = right.map(value => normalize ? value.toLowerCase() : value).sort();
  return normalizedLeft.every((value, index) => value === normalizedRight[index]);
}

function repeatsExistingPlanStep(
  workspaceRoot: string | undefined,
  action: LedgerAction,
  step: StrictPlanStep,
): boolean {
  return action.source === "plan"
    && action.planKind === step.kind
    && action.description === step.description
    && action.mandatory === step.mandatory
    && sameStringSet(action.dependencies, step.dependencies)
    && sameStringSet(action.requiredToolNames, step.requiredToolNames, true)
    && expectedArgumentsEqual(
      workspaceRoot,
      action.expectedArguments ?? {},
      step.expectedArguments,
    )
    && Boolean(action.opensDiscovery) === step.opensDiscovery
    && (step.status === undefined || step.status === action.status)
    && (step.evidenceCallIds === undefined || sameStringSet(step.evidenceCallIds, action.evidenceCallIds))
    && (step.createdRevision === undefined || step.createdRevision === action.createdRevision);
}

function serverStateEchoMatches(action: LedgerAction, step: StrictPlanStep): boolean {
  return (step.status === undefined || step.status === action.status)
    && (step.evidenceCallIds === undefined || sameStringSet(step.evidenceCallIds, action.evidenceCallIds))
    && (step.createdRevision === undefined || step.createdRevision === action.createdRevision);
}

function newStepHasHarmlessStateEcho(ledger: PlanLedgerView, step: StrictPlanStep): boolean {
  const hasServerState = step.status !== undefined
    || step.evidenceCallIds !== undefined
    || step.createdRevision !== undefined;
  if (!hasServerState) return true;
  return ledger.plan.awaitingUpdate
    && step.status === "pending"
    && step.evidenceCallIds?.length === 0
    && step.createdRevision === ledger.plan.revision;
}

interface PlanStepReconciliation {
  additions: StrictPlanStep[];
  replacements: Map<string, StrictPlanStep>;
}

function revisesPendingDiscoveryDescendant(
  ledger: PlanLedgerView,
  action: LedgerAction,
  step: StrictPlanStep,
  actionsById: Map<string, LedgerAction>,
): boolean {
  if (!ledger.plan.awaitingUpdate || !ledger.plan.discoveryCallId || action.status !== "pending") return false;
  const discovery = ledger.actions.find(candidate => (
    candidate.source === "plan"
    && candidate.opensDiscovery
    && candidate.status === "succeeded"
    && candidate.evidenceCallIds.includes(ledger.plan.discoveryCallId!)
  ));
  return Boolean(discovery
    && dependsOn(action, discovery.actionId, actionsById)
    && action.source === "plan"
    && action.planKind === step.kind
    && action.mandatory === step.mandatory
    && sameStringSet(action.dependencies, step.dependencies)
    && sameStringSet(action.requiredToolNames, step.requiredToolNames, true)
    && Boolean(action.opensDiscovery) === step.opensDiscovery
    && serverStateEchoMatches(action, step));
}

function revisesFailedValidationArguments(
  action: LedgerAction,
  step: StrictPlanStep,
): boolean {
  return action.source === "plan"
    && action.status === "failed"
    && action.planKind === "validation"
    && step.kind === "validation"
    && action.description === step.description
    && action.mandatory === step.mandatory
    && sameStringSet(action.dependencies, step.dependencies)
    && sameStringSet(action.requiredToolNames, step.requiredToolNames, true)
    && Boolean(action.opensDiscovery) === step.opensDiscovery
    && serverStateEchoMatches(action, step);
}

function reconcilePlanSteps(
  ledger: PlanLedgerView,
  steps: StrictPlanStep[],
  initialPlan: boolean,
): PlanStepReconciliation | { reason: "duplicate_step" | "server_state_forbidden" } {
  const existingActions = initialPlan ? [] : ledger.actions;
  const existingById = new Map(existingActions.map(action => [action.actionId, action]));
  const incomingIds = new Set<string>();
  const additions: StrictPlanStep[] = [];
  const replacements = new Map<string, StrictPlanStep>();
  for (const step of steps) {
    if (incomingIds.has(step.id)) return { reason: "duplicate_step" };
    incomingIds.add(step.id);
    const existing = existingById.get(step.id);
    if (!existing) {
      if (!newStepHasHarmlessStateEcho(ledger, step)) {
        return { reason: "server_state_forbidden" };
      }
      additions.push(step);
      continue;
    }
    if (repeatsExistingPlanStep(ledger.workspaceRoot, existing, step)) continue;
    if (!revisesPendingDiscoveryDescendant(ledger, existing, step, existingById)
      && !revisesFailedValidationArguments(existing, step)) {
      return { reason: "duplicate_step" };
    }
    replacements.set(step.id, step);
  }
  return { additions, replacements };
}

export function dynamicPlanActionMatchesTool(
  workspaceRoot: string | undefined,
  action: LedgerAction,
  toolCall: CanonicalToolCall,
  policy?: TaskPolicy,
): boolean {
  if (action.source !== "plan") return false;
  if (!action.requiredToolNames.some(name => name.toLowerCase() === toolCall.name.toLowerCase())) return false;
  const frozenTool = policy?.tools.find(tool => tool.name.toLowerCase() === toolCall.name.toLowerCase());
  if (frozenTool?.inputSchema && !matchesToolInputSchema(toolCall.arguments, frozenTool.inputSchema)) return false;
  const expectedArguments = action.expectedArguments ?? {};
  if (!frozenTool?.inputSchema
    && Object.keys(expectedArguments).length !== Object.keys(toolCall.arguments).length) return false;
  return Object.entries(expectedArguments).every(([key, value]) => (
    Object.prototype.hasOwnProperty.call(toolCall.arguments, key)
    && expectedValueMatches(workspaceRoot, key, value, toolCall.arguments[key])
  ));
}

function targetFromExpectedArguments(
  workspaceRoot: string | undefined,
  expectedArguments: Record<string, unknown>,
): string | undefined {
  for (const key of ["file_path", "path", "filename", "file", "directory"]) {
    const value = expectedArguments[key];
    if (typeof value !== "string") continue;
    return resolvedWorkspacePath(workspaceRoot, value) ?? undefined;
  }
  return undefined;
}

function exactVerifierCoversMutationTarget(
  workspaceRoot: string | undefined,
  verifier: LedgerAction,
  mutationTarget: string,
): boolean {
  const expected = verifier.expectedArguments ?? {};
  const toolNames = verifier.requiredToolNames.map(name => name.toLowerCase());
  const candidates: string[] = [];
  if (toolNames.some(name => /^(?:glob|find|list)$/.test(name))) {
    const pattern = expected.pattern;
    if (typeof pattern === "string") {
      const brace = /^\{([^{}]+)\}$/.exec(pattern.trim());
      if (brace) candidates.push(...brace[1]!.split(",").map(value => value.trim()));
      else if (!/[*?{}[\]]/.test(pattern)) candidates.push(pattern);
    }
  }
  if (toolNames.some(name => /bash|shell|powershell|command|exec/.test(name))) {
    const command = expected.command;
    if (typeof command === "string") {
      for (const match of command.matchAll(/"([^"]+)"|'([^']+)'|([^\s]+)/g)) {
        const token = (match[1] ?? match[2] ?? match[3] ?? "").replace(/^[,;]+|[,;]+$/g, "");
        if (token && token !== "--" && !token.startsWith("-")) candidates.push(token);
      }
    }
  }
  return candidates.some(candidate => resolvedWorkspacePath(workspaceRoot, candidate) === mutationTarget);
}

function operationForStep(step: StrictPlanStep): LedgerAction["operation"] {
  if (step.kind === "verification") return "verify";
  if (step.kind !== "mutation") return undefined;
  if (step.requiredToolNames.some(name => /^edit$/i.test(name))) return "edit";
  if (step.requiredToolNames.some(name => /^(?:delete|remove)$/i.test(name))) return "delete";
  return "create";
}

function ledgerKindForStep(step: StrictPlanStep): LedgerAction["kind"] {
  if (step.kind === "mutation") return "file_mutation";
  if (step.kind === "verification") return "file_verification";
  return "tool_execution";
}

function cycleExists(actions: LedgerAction[]): boolean {
  const dependencies = new Map(actions.map(action => [action.actionId, action.dependencies]));
  const visiting = new Set<string>();
  const visited = new Set<string>();
  const visit = (id: string): boolean => {
    if (visiting.has(id)) return true;
    if (visited.has(id)) return false;
    visiting.add(id);
    if ((dependencies.get(id) ?? []).some(visit)) return true;
    visiting.delete(id);
    visited.add(id);
    return false;
  };
  return actions.some(action => visit(action.actionId));
}

function dependsOn(
  action: LedgerAction,
  dependencyId: string,
  actionsById: Map<string, LedgerAction>,
  visited = new Set<string>(),
): boolean {
  if (action.dependencies.includes(dependencyId)) return true;
  if (visited.has(action.actionId)) return false;
  visited.add(action.actionId);
  return action.dependencies.some(id => {
    const dependency = actionsById.get(id);
    return Boolean(dependency && dependsOn(dependency, dependencyId, actionsById, new Set(visited)));
  });
}

export function applyExecutionPlanUpdate(
  ledger: PlanLedgerView,
  baseRevision: number,
  steps: StrictPlanStep[],
  availableTools: readonly string[] | readonly CanonicalTool[],
  now = Date.now(),
): PlanUpdateDecision {
  const initialPlan = initialExecutionPlanRequired(ledger);
  if (baseRevision !== ledger.plan.revision) return { allowed: false, reason: "revision_conflict" };
  if (!ledger.plan.awaitingUpdate && !initialPlan) {
    const existingPlanActions = ledger.actions.filter(action => action.source === "plan");
    const incomingIds = new Set(steps.map(step => step.id));
    const completeSnapshot = ledger.plan.revision > 0
      && steps.length === existingPlanActions.length
      && incomingIds.size === steps.length
      && existingPlanActions.every(action => incomingIds.has(action.actionId));
    const exactSnapshot = completeSnapshot
      && existingPlanActions.every(action => {
        const step = steps.find(candidate => candidate.id === action.actionId);
        return Boolean(step && repeatsExistingPlanStep(ledger.workspaceRoot, action, step));
      });
    if (exactSnapshot) return { allowed: true, reason: "replayed", revision: ledger.plan.revision };
    const correction = completeSnapshot ? reconcilePlanSteps(ledger, steps, false) : { reason: "not_expected" as const };
    const failedValidationCorrection = !("reason" in correction)
      && correction.additions.length === 0
      && correction.replacements.size > 0
      && [...correction.replacements.keys()].every(id => {
        const action = existingPlanActions.find(candidate => candidate.actionId === id);
        return action?.status === "failed" && action.planKind === "validation";
      });
    if (!failedValidationCorrection) return { allowed: false, reason: "not_expected" };
  }
  if (initialPlan && steps.length === 0) return { allowed: false, reason: "empty_initial_plan" };
  const existingActions = initialPlan ? [] : ledger.actions;
  const reconciliation = reconcilePlanSteps(ledger, steps, initialPlan);
  if ("reason" in reconciliation) return { allowed: false, reason: reconciliation.reason };
  const additionsToApply = reconciliation.additions;
  const replacementsToApply = reconciliation.replacements;
  if (existingActions.length + additionsToApply.length > MAX_PLAN_ACTIONS) {
    return { allowed: false, reason: "too_many_steps" };
  }

  const existingIds = new Set(existingActions.map(action => action.actionId));
  const incomingIds = new Set<string>();
  const catalog = availableTools.map(tool => typeof tool === "string" ? { name: tool } : tool);
  const allowed = new Set(catalog.map(tool => tool.name.toLowerCase()));
  const changedSteps = [...additionsToApply, ...replacementsToApply.values()];
  for (const step of changedSteps) {
    if (incomingIds.has(step.id)) return { allowed: false, reason: "duplicate_step" };
    incomingIds.add(step.id);
    if (!step.mandatory) return { allowed: false, reason: "optional_step" };
    if (step.requiredToolNames.length === 0
      || step.requiredToolNames.some(name => !allowed.has(name.toLowerCase()))) {
      return { allowed: false, reason: "unknown_tool" };
    }
    const hasDedicatedMutationTool = step.requiredToolNames.some(name => /^(?:write|edit|create|delete|remove)$/i.test(name));
    const hasOnlyDedicatedReadTools = step.requiredToolNames.every(name => /^(?:read|cat|glob|grep|find|list)$/i.test(name));
    if ((hasDedicatedMutationTool && step.kind !== "mutation")
      || (step.kind === "mutation" && hasOnlyDedicatedReadTools)) {
      return { allowed: false, reason: "tool_kind_mismatch" };
    }
    if (!safeJsonValue(step.expectedArguments)
      || !pathArgumentsStayInWorkspace(ledger.workspaceRoot, step.expectedArguments)) {
      return { allowed: false, reason: "unsafe_arguments" };
    }
    const selectedTools = step.requiredToolNames.map(name => catalog.find(tool => tool.name.toLowerCase() === name.toLowerCase()));
    if (selectedTools.some(tool => tool && "inputSchema" in tool && !matchesToolInputSchemaConstraints(
      step.expectedArguments,
      tool.inputSchema,
    ))) return { allowed: false, reason: "input_schema_mismatch" };
  }
  if (changedSteps.some(step => step.dependencies.some(id => !existingIds.has(id) && !incomingIds.has(id)))) {
    return { allowed: false, reason: "unknown_dependency" };
  }

  const nextRevision = baseRevision + 1;
  const additions: LedgerAction[] = additionsToApply.map(step => ({
    actionId: step.id,
    kind: ledgerKindForStep(step),
    ...(operationForStep(step) ? { operation: operationForStep(step) } : {}),
    ...(targetFromExpectedArguments(ledger.workspaceRoot, step.expectedArguments)
      ? { target: targetFromExpectedArguments(ledger.workspaceRoot, step.expectedArguments) }
      : {}),
    expectedValues: [],
    dependencies: [...step.dependencies],
    requiredToolNames: [...step.requiredToolNames],
    mandatory: true,
    status: "pending",
    failedFingerprints: [],
    source: "plan",
    description: step.description,
    planKind: step.kind,
    createdRevision: nextRevision,
    expectedArguments: structuredClone(step.expectedArguments),
    opensDiscovery: step.opensDiscovery,
    evidenceCallIds: [],
  }));
  const replacementActions = new Map([...replacementsToApply].map(([id, step]) => {
    const existing = existingActions.find(action => action.actionId === id)!;
    const replacement: LedgerAction = {
      ...existing,
      kind: ledgerKindForStep(step),
      ...(operationForStep(step) ? { operation: operationForStep(step) } : { operation: undefined }),
      ...(targetFromExpectedArguments(ledger.workspaceRoot, step.expectedArguments)
        ? { target: targetFromExpectedArguments(ledger.workspaceRoot, step.expectedArguments) }
        : { target: undefined }),
      dependencies: [...step.dependencies],
      requiredToolNames: [...step.requiredToolNames],
      description: step.description,
      planKind: step.kind,
      createdRevision: nextRevision,
      expectedArguments: structuredClone(step.expectedArguments),
      opensDiscovery: step.opensDiscovery,
      failedFingerprints: existing.status === "failed"
        ? [...existing.failedFingerprints]
        : [],
    };
    return [id, replacement];
  }));
  const retainedActions = existingActions.map(action => replacementActions.get(action.actionId) ?? action);
  if (cycleExists([...retainedActions, ...additions])) return { allowed: false, reason: "cyclic_dependency" };

  const allActions = [...retainedActions, ...additions];
  const actionsById = new Map(allActions.map(action => [action.actionId, action]));
  const affectedActions = [...replacementActions.values(), ...additions];
  const mutationsToVerify = initialPlan
    ? affectedActions.filter(action => action.planKind === "mutation")
    : allActions.filter(action => action.source === "plan" && action.planKind === "mutation");
  const provisionalDiscovery = initialPlan && allActions.some(action => (
    action.source === "plan" && action.opensDiscovery
  ));
  for (const mutation of mutationsToVerify) {
    const freshVerification = allActions.some(candidate => (
      candidate.mandatory
      && (candidate.planKind === "verification" || candidate.planKind === "validation")
      && dependsOn(candidate, mutation.actionId, actionsById)
      && (!mutation.target
        ? !candidate.target
        : candidate.target === mutation.target
          || exactVerifierCoversMutationTarget(ledger.workspaceRoot, candidate, mutation.target)
          || (provisionalDiscovery && !candidate.target))
    ));
    if (!freshVerification) return { allowed: false, reason: "missing_fresh_verification" };
  }

  for (const addition of affectedActions) {
    if (addition.planKind !== "mutation") continue;
    const duplicate = existingActions.some(action => action.actionId !== addition.actionId
      && action.status === "succeeded"
      && action.planKind === "mutation"
      && action.requiredToolNames.some(name => addition.requiredToolNames.some(other => name.toLowerCase() === other.toLowerCase()))
      && expectedArgumentsEqual(
        ledger.workspaceRoot,
        action.expectedArguments ?? {},
        addition.expectedArguments ?? {},
      ));
    if (duplicate) return { allowed: false, reason: "duplicate_succeeded_mutation" };
  }
  for (const addition of affectedActions) {
    if (addition.planKind !== "mutation") continue;
    const duplicate = allActions.some(candidate => candidate.actionId !== addition.actionId
      && candidate.planKind === "mutation"
      && candidate.status !== "succeeded"
      && candidate.requiredToolNames.some(name => addition.requiredToolNames.some(other => name.toLowerCase() === other.toLowerCase()))
      && expectedArgumentsEqual(
        ledger.workspaceRoot,
        candidate.expectedArguments ?? {},
        addition.expectedArguments ?? {},
      ));
    if (duplicate) return { allowed: false, reason: "duplicate_mutation" };
  }

  ledger.actions = allActions;
  ledger.plan.revision = nextRevision;
  ledger.plan.awaitingUpdate = false;
  delete ledger.plan.discoveryCallId;
  ledger.plan.updatedAt = now;
  ledger.unresolvedIntent = false;
  ledger.updatedAt = now;
  return { allowed: true, reason: "applied", revision: nextRevision };
}

function taskPolicyPlanSteps(
  ledger: PlanLedgerView,
  additions: StrictPlanStep[],
  replacements: Map<string, StrictPlanStep>,
  initialPlan: boolean,
): TaskPolicyPlanStep[] {
  const existing = initialPlan
    ? []
    : ledger.actions
      .filter(action => action.source === "plan" && action.planKind)
      .map(action => replacements.get(action.actionId) ?? ({
          id: action.actionId,
          kind: action.planKind!,
          description: action.description,
          mandatory: action.mandatory,
          requiredToolNames: [...action.requiredToolNames],
          expectedArguments: structuredClone(action.expectedArguments ?? {}),
          dependencies: [...action.dependencies],
          opensDiscovery: action.opensDiscovery,
        }))
      .map(step => ({
        id: step.id,
        kind: step.kind,
        requiredToolNames: [...step.requiredToolNames],
        expectedArguments: structuredClone(step.expectedArguments),
        dependencies: [...(step.dependencies ?? [])],
        opensDiscovery: step.opensDiscovery,
      }));
  return [...existing, ...additions];
}

function resolveSchemaBoundToolChoices(
  steps: readonly StrictPlanStep[],
  availableTools: readonly string[] | readonly CanonicalTool[],
): StrictPlanStep[] {
  const catalog = availableTools.map(tool => typeof tool === "string" ? { name: tool } : tool);
  return steps.map(step => {
    if (step.requiredToolNames.length <= 1 || Object.keys(step.expectedArguments).length === 0) return step;
    const requested = step.requiredToolNames.map(name => (
      catalog.find(tool => tool.name.toLowerCase() === name.toLowerCase())
    ));
    if (requested.some(tool => !tool)) return step;
    const compatible = requested.filter((tool): tool is CanonicalTool => Boolean(
      tool
      && "inputSchema" in tool
      && tool.inputSchema
      && matchesToolInputSchemaConstraints(step.expectedArguments, tool.inputSchema),
    ));
    if (compatible.length !== 1) return step;
    return { ...step, requiredToolNames: [compatible[0]!.name] };
  });
}

function normalizeInitialInputDiscovery(
  ledger: PlanLedgerView,
  steps: readonly StrictPlanStep[],
  initialPlan: boolean,
): { steps: StrictPlanStep[]; allowsUncoveredDeferral: boolean } {
  if (!initialPlan || steps.length !== 1) {
    return { steps: [...steps], allowsUncoveredDeferral: false };
  }
  const step = steps[0]!;
  if (!step.mandatory
    || step.dependencies.length > 0
    || step.requiredToolNames.length !== 1
    || !/^(?:read|cat|glob|grep|find|list)$/i.test(step.requiredToolNames[0]!)) {
    return { steps: [...steps], allowsUncoveredDeferral: false };
  }

  const pendingMutations = ledger.actions.filter(action => (
    action.source === "inferred"
    && action.mandatory
    && action.status === "pending"
    && (action.kind === "file_mutation" || action.kind === "data_mutation")
  ));
  if (pendingMutations.length === 0) {
    return { steps: [...steps], allowsUncoveredDeferral: false };
  }

  const discoveryTarget = targetFromExpectedArguments(ledger.workspaceRoot, step.expectedArguments);
  const pendingCreateTargets = new Set(pendingMutations
    .filter(action => action.operation === "create" && Boolean(action.target))
    .map(action => resolvedWorkspacePath(ledger.workspaceRoot, action.target!))
    .filter((target): target is string => Boolean(target)));
  const frozenInputTargets = [...new Set(ledger.actions
    .filter(action => (
      action.source === "inferred"
      && action.mandatory
      && action.status === "pending"
      && action.kind === "file_verification"
      && Boolean(action.target)
    ))
    .map(action => resolvedWorkspacePath(ledger.workspaceRoot, action.target!))
    .filter((target): target is string => (
      typeof target === "string" && target.length > 0 && !pendingCreateTargets.has(target)
    )))];
  if (frozenInputTargets.length > 0
    && (!discoveryTarget || !frozenInputTargets.includes(discoveryTarget))) {
    return { steps: [...steps], allowsUncoveredDeferral: false };
  }
  const readsUncreatedOutput = Boolean(discoveryTarget && pendingMutations.some(action => (
    action.operation === "create"
    && action.target
    && resolvedWorkspacePath(ledger.workspaceRoot, action.target) === discoveryTarget
  )));
  if (readsUncreatedOutput) {
    return { steps: [...steps], allowsUncoveredDeferral: false };
  }

  return {
    steps: [{ ...step, kind: "discovery", opensDiscovery: true }],
    allowsUncoveredDeferral: true,
  };
}

function safelyDefersOriginalRequirements(
  ledger: PlanLedgerView,
  reconciliation: PlanStepReconciliation,
  initialPlan: boolean,
): boolean {
  if (reconciliation.replacements.size > 0) return false;
  if (initialPlan) {
    const discovery = reconciliation.additions[0];
    return reconciliation.additions.length === 1
      && discovery?.mandatory === true
      && discovery.kind === "discovery"
      && discovery.opensDiscovery
      && discovery.dependencies.length === 0;
  }
  if (!ledger.plan.awaitingUpdate || !ledger.plan.discoveryCallId) return false;
  const completedDiscovery = ledger.actions.find(action => (
    action.source === "plan"
    && action.opensDiscovery
    && action.status === "succeeded"
    && action.evidenceCallIds.includes(ledger.plan.discoveryCallId!)
  ));
  if (!completedDiscovery) return false;
  if (reconciliation.additions.length === 0) {
    return ledger.actions.some(action => (
      action.source === "plan"
      && action.status === "pending"
      && action.planKind === "discovery"
      && action.opensDiscovery
      && action.dependencies.every(id => ledger.actions.find(candidate => candidate.actionId === id)?.status === "succeeded")
    ));
  }
  const discoveries = new Map(reconciliation.additions.map(step => [step.id, step]));
  const linkedToCompleted = (step: StrictPlanStep, visiting = new Set<string>()): boolean => {
    if (visiting.has(step.id)) return false;
    visiting.add(step.id);
    return step.dependencies.some(id => {
      if (id === completedDiscovery.actionId) return true;
      const dependency = discoveries.get(id);
      return Boolean(dependency && linkedToCompleted(dependency, new Set(visiting)));
    });
  };
  return reconciliation.additions.every(step => (
    step.mandatory
    && step.kind === "discovery"
    && step.opensDiscovery
    && linkedToCompleted(step)
  ));
}

function closeTerminalFiniteDiscoverySteps(
  ledger: PlanLedgerView,
  steps: StrictPlanStep[],
  policySteps: TaskPolicyPlanStep[],
  additions: readonly StrictPlanStep[],
  availableTools: readonly string[] | readonly CanonicalTool[],
  discoveredMutationTargets: readonly string[],
): StrictPlanStep[] {
  if (ledger.taskPolicy.readScope !== "exact" || ledger.taskPolicy.mutationScope === "workspace") return steps;
  if (!authorizeExecutionPlan(
    ledger.taskPolicy,
    policySteps,
    availableTools,
    true,
    false,
    discoveredMutationTargets,
  ).allowed) return steps;

  const additionIds = new Set(additions.map(step => step.id));
  const dependedOn = new Set(policySteps.flatMap(step => step.dependencies ?? []));
  const terminalIds = new Set(policySteps
    .filter(step => additionIds.has(step.id ?? "") && step.opensDiscovery && !dependedOn.has(step.id ?? ""))
    .map(step => step.id!));
  if (terminalIds.size === 0) return steps;
  return steps.map(step => terminalIds.has(step.id) ? { ...step, opensDiscovery: false } : step);
}

export function routeExecutionPlanUpdate(
  mode: GenericToolRuntimeMode,
  ledger: PlanLedgerView,
  baseRevision: number,
  steps: StrictPlanStep[],
  availableTools: readonly string[] | readonly CanonicalTool[],
  now = Date.now(),
): PlanUpdateRolloutDecision {
  const schemaBoundSteps = resolveSchemaBoundToolChoices(steps, availableTools);
  const discoveredMutationTargets = [...new Set(ledger.actions
    .filter(action => action.opensDiscovery && action.status === "succeeded")
    .flatMap(action => action.resultValues ?? [])
    .map(target => resolveTaskPolicyPath(ledger.workspaceRoot, target))
    .filter((target): target is string => Boolean(target)))];
  if (mode === "enabled") {
    const initialPlan = initialExecutionPlanRequired(ledger);
    const initialDiscovery = normalizeInitialInputDiscovery(ledger, schemaBoundSteps, initialPlan);
    const normalizedSteps = initialDiscovery.steps;
    const reconciliation = reconcilePlanSteps(ledger, normalizedSteps, initialPlan);
    if ("reason" in reconciliation) {
      return {
        decision: { allowed: false, reason: reconciliation.reason },
        mode,
        applied: false,
      };
    }
    const policySteps = taskPolicyPlanSteps(
      ledger,
      reconciliation.additions,
      reconciliation.replacements,
      initialPlan,
    );
    const policy = authorizeExecutionPlan(
      ledger.taskPolicy,
      policySteps,
      availableTools,
      initialPlan || ledger.plan.awaitingUpdate,
      safelyDefersOriginalRequirements(ledger, reconciliation, initialPlan),
      discoveredMutationTargets,
      initialDiscovery.allowsUncoveredDeferral,
    );
    if (!policy.allowed) {
      return {
        decision: { allowed: false, reason: policy.reason },
        mode,
        applied: false,
      };
    }
    const stepsToApply = closeTerminalFiniteDiscoverySteps(
      ledger,
      normalizedSteps,
      policySteps,
      reconciliation.additions,
      availableTools,
      discoveredMutationTargets,
    );
    const decision = applyExecutionPlanUpdate(ledger, baseRevision, stepsToApply, availableTools, now);
    return { decision, mode, applied: decision.allowed };
  }
  if (mode === "shadow") {
    const shadowLedger = structuredClone(ledger) as PlanLedgerView;
    if (shadowLedger.plan.revision === 0
      && shadowLedger.callLedger.calls.length === 0
      && shadowLedger.actions.every(action => action.source === "inferred" && action.status === "pending")) {
      shadowLedger.unresolvedIntent = shadowLedger.unresolvedIntent || shadowLedger.actions.length > 0;
    }
    const initialPlan = initialExecutionPlanRequired(shadowLedger);
    const initialDiscovery = normalizeInitialInputDiscovery(shadowLedger, schemaBoundSteps, initialPlan);
    const normalizedSteps = initialDiscovery.steps;
    const reconciliation = reconcilePlanSteps(shadowLedger, normalizedSteps, initialPlan);
    if ("reason" in reconciliation) {
      return {
        decision: { allowed: false, reason: "shadow_only" },
        mode,
        applied: false,
        shadowDecision: { allowed: false, reason: reconciliation.reason },
      };
    }
    const policySteps = taskPolicyPlanSteps(
      shadowLedger,
      reconciliation.additions,
      reconciliation.replacements,
      initialPlan,
    );
    const policy = authorizeExecutionPlan(
      shadowLedger.taskPolicy,
      policySteps,
      availableTools,
      initialPlan || shadowLedger.plan.awaitingUpdate,
      safelyDefersOriginalRequirements(shadowLedger, reconciliation, initialPlan),
      discoveredMutationTargets,
      initialDiscovery.allowsUncoveredDeferral,
    );
    const stepsToApply = policy.allowed
      ? closeTerminalFiniteDiscoverySteps(
          shadowLedger,
          normalizedSteps,
          policySteps,
          reconciliation.additions,
          availableTools,
          discoveredMutationTargets,
        )
      : normalizedSteps;
    const shadowDecision = policy.allowed
      ? applyExecutionPlanUpdate(shadowLedger, baseRevision, stepsToApply, availableTools, now)
      : { allowed: false, reason: policy.reason } as PlanUpdateDecision;
    return {
      decision: { allowed: false, reason: "shadow_only" },
      mode,
      applied: false,
      shadowDecision,
    };
  }
  return {
    decision: { allowed: false, reason: "not_expected" },
    mode,
    applied: false,
  };
}

export function requireExecutionPlanUpdate(
  ledger: PlanLedgerView,
  discoveryCallId: string,
  now = Date.now(),
): void {
  ledger.plan.awaitingUpdate = true;
  ledger.plan.discoveryCallId = discoveryCallId;
  ledger.plan.updatedAt = now;
  ledger.updatedAt = now;
}

export function executionPlanPrompt(
  ledger: PlanLedgerView,
  mode: Exclude<GenericToolRuntimeMode, "legacy"> = "enabled",
): string {
  const initialPlanAllowed = initialExecutionPlanRequired(ledger);
  const shadowProposalAllowed = mode === "shadow"
    && ledger.plan.revision === 0
    && ledger.callLedger.calls.length === 0
    && ledger.actions.length > 0
    && ledger.actions.every(action => action.source === "inferred" && action.status === "pending");
  const state = {
    revision: ledger.plan.revision,
    awaiting_update: ledger.plan.awaitingUpdate,
    initial_update_required: initialPlanAllowed,
    discovery_call_id: ledger.plan.discoveryCallId ?? null,
    frozen_requirements: ledger.taskPolicy.requirements.map(requirement => ({
      kind: requirement.kind,
      operation: requirement.operation ?? null,
      target: requirement.target
        ? promptWorkspaceTarget(ledger.workspaceRoot, requirement.target)
        : null,
      required_tool_names: requirement.requiredToolNames,
      fixed_expected_value_count: requirement.expectedValues.length,
    })),
    steps: (mode === "enabled" && initialPlanAllowed ? [] : ledger.actions).map(action => ({
      id: action.actionId,
      kind: action.planKind ?? "action",
      description: action.description,
      mandatory: action.mandatory,
      dependencies: action.dependencies,
      status: action.status,
      required_tool_names: action.requiredToolNames,
      expected_arguments: action.expectedArguments ?? {},
      opens_discovery: action.opensDiscovery ?? false,
      evidence_call_ids: action.evidenceCallIds ?? [],
      created_revision: action.createdRevision ?? 0,
    })),
  };
  return [
    "--- BRIDGE EXECUTION PLAN ---",
    JSON.stringify(state),
    "The Bridge is the authority for step status and evidence. Never claim a pending step is complete.",
    "frozen_requirements are the server-owned minimum outcomes from the current user request. Preserve their operation and exact target when building or extending the plan; discovery may add detail but cannot replace or weaken them.",
    "When structured Write and Edit tools are available, use Write for a create operation and Edit for an edit operation unless the user explicitly required another tool. A discovered validation step must transitively depend on the discovery that read its script or package metadata.",
    mode === "shadow"
      ? "SHADOW MODE: a plan_update is diagnostic only and cannot authorize or expose a tool. Existing ledger actions remain the sole execution authority."
      : "ENABLED MODE: an atomic tool_call and its attached plan_update are checked together; the accepted plan is persisted before that tool can be exposed.",
    ledger.plan.awaitingUpdate
      ? "Before another tool or finish, return one exact tool_call carrying a plan_update for the current base_revision. Include every newly discovered mandatory step. If exact work still depends on more sources, append only mandatory discovery steps with opens_discovery=true, link them by dependencies to the just-completed discovery, and execute one currently available discovery as the outer tool_call; defer unresolved work only until those results. You may repeat the complete existing plan snapshot. Succeeded or running steps must remain exactly unchanged. A pending step that depends on the just-completed discovery may keep its ID, kind, mandatory flag, dependencies, required tools and opens_discovery flag while revising only its description and expected_arguments to reflect discovered facts. A failed validation step may keep its ID and revise only expected_arguments to correct the failed invocation; its identity, dependencies and required tool stay fixed. Every known file mutation target must now have a dependency-linked verification or validation step for that same exact target; distinct targets require distinct target-bound evidence steps. Use a plan_update envelope without a tool only when discovery proved there is no additional work."
      : initialPlanAllowed
        ? "Before any tool or finish, return one exact initial tool_call carrying a plan_update at base_revision 0. The tool must be the first executable plan step. Include every currently known mandatory step. When later work depends on discovery output, you may submit only one root discovery step with opens_discovery=true and add dependent steps after its result; if you include pending dependent steps now, their description and expected_arguments may be revised only after that discovery succeeds."
        : shadowProposalAllowed
          ? "Before the first legacy tool, you may return one diagnostic plan_update at base_revision 0. It is validated on a copy and cannot expose a tool or change persisted state."
        : "Return the next executable tool_call, or finish only after every mandatory step has succeeded.",
    "An atomic tool_call must have exactly: type, name, arguments, plan_update. Its plan_update must have exactly: base_revision, steps.",
    "A new plan_update step must have exactly: id, kind, description, mandatory, dependencies, required_tool_names, expected_arguments, opens_discovery.",
    "An existing step may echo status, evidence_call_ids, and created_revision only when every echoed field exactly matches the current server-owned step. A newly discovered step may include only the inert snapshot values status=pending, evidence_call_ids=[], and created_revision=current base revision; these never grant status or evidence and the Bridge assigns the accepted revision. Except for a pending discovery descendant or a failed validation correction, an existing step is immutable.",
    "kind is one of discovery, mutation, verification, validation, action. Every added step must be mandatory and name exactly one currently available tool; required_tool_names is not an alternatives list.",
    "A future step's expected_arguments are exact subset constraints: include only argument keys already known, and omit values that depend on discovery. The outer tool_call arguments must satisfy the complete tool schema.",
    "Use workspace-relative paths in plan constraints. Never invent an absolute path or a placeholder value.",
    "Use Read for PDF and XLSX source files. The Bridge materializes a correlated binary Read into textual evidence; do not replace that source inspection with shell code.",
    "A delegated validation command must be a simple direct workspace script or package validation command. Read that exact script or package.json in an earlier dependency-linked discovery step before proposing the validation command; compound shell commands remain forbidden.",
    "Every mutation must have a later dependency-linked verification or validation step. After discovery, every known file mutation target must be verified on that same exact target; one targetless verification cannot prove multiple distinct files.",
    ...(initialPlanAllowed ? [
      "Output ONLY one atomic canonical tool_call carrying plan_update and nothing else:",
      "<bridge_tool_call>",
      JSON.stringify({
        type: "tool_call",
        name: "ToolName",
        arguments: {},
        plan_update: {
          base_revision: ledger.plan.revision,
          steps: [{
            id: "unique-step-id",
            kind: "action",
            description: "required work",
            mandatory: true,
            dependencies: [],
            required_tool_names: ["ToolName"],
            expected_arguments: {},
            opens_discovery: false,
          }],
        },
      }),
      "</bridge_tool_call>",
    ] : []),
    "--- END BRIDGE EXECUTION PLAN ---",
  ].join("\n");
}
