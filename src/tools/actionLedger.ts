import { createHash } from "node:crypto";
import path from "node:path";
import type { CanonicalMessage, CanonicalRequest, CanonicalTool, CanonicalToolCall } from "../api/canonical.js";
import {
  inferToolObligations,
  isInformationalRequest,
  looksLikeExplicitCommandExecutionRequest,
  looksLikeEnvironmentDataRequest,
  looksLikeExternalActionRequest,
  toolCallFingerprint,
  type ExternalActionKind,
  type ToolObligation,
} from "./toolParser.js";
import {
  activeCallForAction,
  createCallLedger,
  finalizeCall,
  findCallRecord,
  interruptOpenCalls,
  markCallExposed,
  proposeCall,
  recordCallResult,
  type CallLedger,
} from "./callLedger.js";
import {
  createExecutionPlanState,
  dynamicPlanActionMatchesTool,
  requireExecutionPlanUpdate,
  type ExecutionPlanState,
  type PlanStepKind,
} from "./executionPlan.js";
import {
  createTaskPolicy,
  isConfidentlyReadOnlyCommand,
  type TaskPolicy,
} from "./taskPolicy.js";

export type ActionStatus = "pending" | "running" | "succeeded" | "failed" | "stale";
export type FileActionOperation = "create" | "edit" | "delete" | "verify";

export interface LedgerAction {
  actionId: string;
  kind: ExternalActionKind | "environment_inspection" | "tool_execution";
  operation?: FileActionOperation;
  target?: string;
  expectedValues: string[];
  resultValues?: string[];
  dependencies: string[];
  requiredToolNames: string[];
  mandatory: boolean;
  status: ActionStatus;
  failedFingerprints: string[];
  source: "inferred" | "plan";
  description: string;
  planKind?: PlanStepKind;
  createdRevision: number;
  expectedArguments?: Record<string, unknown>;
  opensDiscovery: boolean;
  evidenceCallIds: string[];
}

export interface ActionLedger {
  version: 4;
  turnKey: string;
  workspaceRoot?: string;
  actions: LedgerAction[];
  unresolvedIntent: boolean;
  callLedger: CallLedger;
  plan: ExecutionPlanState;
  taskPolicy: TaskPolicy;
  updatedAt: number;
}

export interface LedgerAdmission {
  allowed: boolean;
  actionId?: string;
  reason: "matched" | "no_action" | "blocked_dependency" | "wrong_target" | "wrong_tool" | "duplicate" | "repeated_failure";
}

interface PlannedAction {
  kind: LedgerAction["kind"];
  operation?: FileActionOperation;
  target?: string;
  expectedValues: string[];
  resultValues?: string[];
  requiredToolNames: string[];
  position: number;
  sequenceGroup?: string;
}

interface ActionMention {
  start: number;
  end: number;
  operation: FileActionOperation | "command" | "inspect";
  verb: string;
}

interface NumberedPlanStep {
  number: number;
  markerStart: number;
  bodyStart: number;
  end: number;
  body: string;
}

const FILE_TARGET = /(?:[a-zA-Z]:[\\/][^\s"'`;,]+|(?<![\p{L}\p{N}_-])(?:\.{1,2}[\\/])?(?:(?:\.[\p{L}\p{N}_-]+|[\p{L}\p{N}_-][\p{L}\p{N}_.-]*)[\\/])*[\p{L}\p{N}_-][\p{L}\p{N}_.-]*\.(?:txt|md|json|ya?ml|toml|html?|css|jsx?|tsx?|mjs|cjs|py|go|rs|java|xml|csv|tsv|pdf|xlsx|log|ini|conf|sh|bat|ps1))(?![\p{L}\p{N}_-])/giu;
const ACTION_VERB = /(?:созда(?:вать|йте|вай|ть|й)|запиш(?:ите|ать|ем|и)|сохран(?:ите|ить|и)|write|create|save|исправ(?:ь|те|ить|ляй(?:те)?|лять)|fix(?:ed|es|ing)?|измен(?:ите|ить|яй|ять|и)|замен(?:ите|ить|яй|ять|и)|отредактир(?:овать|уйте|уй)|edit|modify|change|replace|удал(?:ите|ить|и)|delete|remove|прочит(?:айте|ать|ай)|прочт(?:ите|и)|провер(?:яй|ять|ьте|ить|ь)|изуч(?:ите|ить|и)|read|verify|inspect|check|выполн(?:ите|ить|и)|запуст(?:ите|ить|и)|run|execute|покаж(?:ите|ать|и)|перечисл(?:ите|ить|и)|найд(?:ите|ти|и)|list|show|find)/giu;
const SEQUENCE_CUE = /(?:^|[\s,.;:])(?:затем|потом|после\s+этого|снова|далее|then|after\s+that|again|next)(?=$|[\s,.;:])/iu;
const NEGATED_PREFIX = /(?:^|[\s,.;:])(?:не|никогда|без|do\s+not|don't|never|without)\s+(?:\S+\s+){0,2}$/iu;
const NUMBERED_MARKER = /(?:^|\s)(\d{1,3})[.)]\s+/gu;

function digest(value: string): string {
  return createHash("sha256").update(value).digest("hex").slice(0, 16);
}

function normalizeValue(value: string): string {
  return value.normalize("NFC").trim();
}

function isWindowsPath(value: string): boolean {
  return /^[a-z]:[\\/]/i.test(value) || /^\\\\/.test(value);
}

function pathApi(value: string): typeof path.posix {
  return isWindowsPath(value) ? path.win32 : path.posix;
}

function normalizedStandalonePath(value: string): string {
  const api = pathApi(value);
  const normalized = api.normalize(normalizeValue(value));
  return api === path.win32 ? normalized.toLowerCase() : normalized;
}

function resolvedWorkspacePath(workspaceRoot: string | undefined, value: string): string | undefined {
  if (!workspaceRoot) return normalizedStandalonePath(value);
  const api = pathApi(workspaceRoot);
  const root = api.resolve(workspaceRoot);
  const resolved = api.resolve(root, normalizeValue(value));
  const relative = api.relative(root, resolved);
  if (relative === ".." || relative.startsWith(`..${api.sep}`) || api.isAbsolute(relative)) return undefined;
  const normalized = api.normalize(resolved);
  return api === path.win32 ? normalized.toLowerCase() : normalized;
}

function sameTarget(workspaceRoot: string | undefined, expected: string, actual: string): boolean {
  const left = resolvedWorkspacePath(workspaceRoot, expected);
  const right = resolvedWorkspacePath(workspaceRoot, actual);
  if (!left || !right) return false;
  if (!workspaceRoot) {
    const leftAbsolute = path.posix.isAbsolute(left) || path.win32.isAbsolute(left);
    const rightAbsolute = path.posix.isAbsolute(right) || path.win32.isAbsolute(right);
    if (leftAbsolute !== rightAbsolute) return false;
  }
  return left === right;
}

function workspaceRootFromSystem(system: string): string | undefined {
  const candidates: string[] = [];
  const xml = /<cwd>\s*([^<\r\n]+?)\s*<\/cwd>/giu.exec(system)?.[1];
  if (xml) candidates.push(xml);
  const labelled = /(?:^|\r?\n)\s*(?:[-*]\s*)?(?:cwd|(?:primary|current)?\s*working directory)\s*:\s*([^\r\n]+)/gimu;
  for (const match of system.matchAll(labelled)) candidates.push(match[1] ?? "");
  for (let index = candidates.length - 1; index >= 0; index--) {
    const candidate = normalizeValue(candidates[index] ?? "")
      .replace(/^[`'"]+|[`'"]+$/g, "")
      .trim();
    if (path.posix.isAbsolute(candidate) || path.win32.isAbsolute(candidate)) {
      return normalizedStandalonePath(candidate);
    }
  }
  return undefined;
}

function pathArguments(toolCall: CanonicalToolCall): string[] {
  const args = toolCall.arguments;
  const direct = [args.file_path, args.path, args.filename, args.file]
    .filter((value): value is string => typeof value === "string");
  if (direct.length > 0) return direct;
  if (/^(?:glob|grep|find|list)/i.test(toolCall.name)) {
    return [args.pattern, args.glob, args.directory]
      .filter((value): value is string => typeof value === "string");
  }
  return [];
}

function commandArgument(toolCall: CanonicalToolCall): string | undefined {
  const value = toolCall.arguments.command ?? toolCall.arguments.cmd;
  return typeof value === "string" ? value.trim() : undefined;
}

function exactVerificationContent(content: string): string {
  const normalized = content.normalize("NFC").replace(/\r\n?/g, "\n").replace(/\n+$/u, "");
  const lines = normalized.split("\n");
  const numbered = lines.map(line => /^\s*\d+(?:→|\t)(.*)$/u.exec(line));
  if (numbered.length > 0 && numbered.every(match => match !== null)) {
    return numbered.map(match => match![1]).join("\n").replace(/\n+$/u, "");
  }
  return normalized;
}

function transitivelyDependsOnAction(
  ledger: ActionLedger,
  action: LedgerAction,
  dependencyId: string,
  visited = new Set<string>(),
): boolean {
  if (action.dependencies.includes(dependencyId)) return true;
  if (visited.has(action.actionId)) return false;
  visited.add(action.actionId);
  return action.dependencies.some(id => {
    const dependency = ledger.actions.find(candidate => candidate.actionId === id);
    return Boolean(dependency
      && transitivelyDependsOnAction(ledger, dependency, dependencyId, new Set(visited)));
  });
}

function latestVerifiedMutation(ledger: ActionLedger, action: LedgerAction): LedgerAction | undefined {
  if (!action.target) return undefined;
  for (let index = ledger.actions.length - 1; index >= 0; index--) {
    const candidate = ledger.actions[index]!;
    if (candidate.kind === "file_mutation"
      && candidate.status === "succeeded"
      && candidate.target
      && sameTarget(ledger.workspaceRoot, action.target, candidate.target)
      && transitivelyDependsOnAction(ledger, action, candidate.actionId)) {
      return candidate;
    }
  }
  return undefined;
}

function verificationResultMatches(ledger: ActionLedger, action: LedgerAction, content: string): boolean {
  const mutation = latestVerifiedMutation(ledger, action);
  if (mutation?.operation === "edit") {
    const replacement = typeof mutation.expectedArguments?.new_string === "string"
      ? normalizeValue(mutation.expectedArguments.new_string)
      : mutation.resultValues?.[0];
    if (!replacement) return false;
    const actual = exactVerificationContent(content);
    const escaped = replacement.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const startsWithWord = /^[\p{L}\p{N}_-]/u.test(replacement);
    const endsWithWord = /[\p{L}\p{N}_-]$/u.test(replacement);
    const replacementPresent = new RegExp(
      `${startsWithWord ? "(?<![\\p{L}\\p{N}_-])" : ""}${escaped}${endsWithWord ? "(?![\\p{L}\\p{N}_-])" : ""}`,
      "u",
    ).test(actual);
    const oldValue = typeof mutation.expectedArguments?.old_string === "string"
      ? normalizeValue(mutation.expectedArguments.old_string)
      : undefined;
    return replacementPresent && (!oldValue || replacement.includes(oldValue) || !actual.includes(oldValue));
  }
  if (action.expectedValues.length === 0) return true;
  const expected = action.expectedValues.map(normalizeValue);
  return expected.length === 1 && exactVerificationContent(content) === expected[0];
}

function classifyOperation(verb: string): ActionMention["operation"] {
  if (/^(?:созда|запиш|сохран|write|create|save)/iu.test(verb)) return "create";
  if (/^(?:исправ|fix|измен|замен|отредактир|edit|modify|change|replace)/iu.test(verb)) return "edit";
  if (/^(?:удал|delete|remove)/iu.test(verb)) return "delete";
  if (/^(?:прочит|прочт|провер|изуч|read|verify|inspect|check)/iu.test(verb)) return "verify";
  if (/^(?:выполн|запуст|run|execute)/iu.test(verb)) return "command";
  return "inspect";
}

function isInformationalMutationMention(text: string, start: number): boolean {
  const before = text.slice(0, start);
  const boundary = Math.max(
    before.lastIndexOf("."),
    before.lastIndexOf("!"),
    before.lastIndexOf("?"),
    before.lastIndexOf(";"),
    before.lastIndexOf("\n"),
    before.lastIndexOf("\r"),
  );
  const clause = text.slice(boundary + 1).trim();
  const localPrefix = text.slice(Math.max(boundary + 1, start - 160), start);
  return isInformationalRequest(clause)
    || /(?:\b(?:explain|tell\s+me|describe)\b[^.!?;\r\n]{0,96}\bhow\s+to\s*|(?:объясни|расскажи|опиши)\S*[^.!?;\r\n]{0,96}как\s*)$/iu.test(localPrefix);
}

function actionMentions(text: string, allowedToolNames: string[]): ActionMention[] {
  const candidates: Array<ActionMention & { excluded: boolean }> = [];
  const actionText = text.replace(/`[^`\r\n]*`/gu, match => " ".repeat(match.length));
  ACTION_VERB.lastIndex = 0;
  for (const match of actionText.matchAll(ACTION_VERB)) {
    const start = match.index ?? 0;
    const before = start > 0 ? text[start - 1] : undefined;
    const after = text[start + match[0].length];
    if ((before && /[\p{L}\p{N}_-]/u.test(before)) || (after && /[\p{L}\p{N}_-]/u.test(after))) continue;
    if (/^\.[\p{L}\p{N}]/u.test(text.slice(start + match[0].length))) continue;
    const prefix = text.slice(Math.max(0, start - 32), start);
    const namedToolMeta = allowedToolNames.some(name => name.toLowerCase() === match[0].toLowerCase())
      && /(?:use|call|invoke|using|via|with|с\s+помощью|через|используя|используй(?:те)?)\s*$/iu.test(prefix);
    const operation = classifyOperation(match[0]);
    candidates.push({
      start,
      end: text.length,
      operation,
      verb: match[0],
      excluded: namedToolMeta
        || NEGATED_PREFIX.test(prefix)
        || ((operation === "create" || operation === "edit" || operation === "delete")
          && isInformationalMutationMention(text, start)),
    });
  }
  for (let index = 0; index < candidates.length; index++) {
    candidates[index]!.end = candidates[index + 1]?.start ?? text.length;
  }
  const mentions = candidates.filter(candidate => (
    !candidate.excluded
    && (candidate.operation !== "command"
      || looksLikeExplicitCommandExecutionRequest(text.slice(candidate.start, candidate.end)))
  ));
  const numberedSteps = structuredNumberedSteps(text);
  return mentions.filter((mention, index) => {
    if (index !== 0 || mention.operation !== "command" || mentions.length < 2) return true;
    return numberedSteps.length < 2 || mention.start >= numberedSteps[0]!.bodyStart;
  });
}

function structuredNumberedSteps(text: string): NumberedPlanStep[] {
  NUMBERED_MARKER.lastIndex = 0;
  const markers = [...text.matchAll(NUMBERED_MARKER)].map(match => {
    const markerOffset = (match[0] ?? "").search(/\d/u);
    return {
      number: Number(match[1]),
      markerStart: (match.index ?? 0) + Math.max(0, markerOffset),
      bodyStart: (match.index ?? 0) + (match[0]?.length ?? 0),
    };
  });
  if (markers.length < 2) return [];
  for (let index = 1; index < markers.length; index++) {
    if (markers[index]!.number !== markers[index - 1]!.number + 1) return [];
  }
  return markers.map((marker, index) => {
    const end = markers[index + 1]?.markerStart ?? text.length;
    return {
      ...marker,
      end,
      body: text.slice(marker.bodyStart, end).trim(),
    };
  });
}

function exactValues(segment: string): string[] {
  const values: string[] = [];
  for (const match of segment.matchAll(/"([^"\r\n]{1,2048})"|'([^'\r\n]{1,2048})'|«([^»\r\n]{1,2048})»/g)) {
    const value = normalizeValue(match[1] ?? match[2] ?? match[3] ?? "");
    if (value && !FILE_TARGET.test(value)) values.push(value);
    FILE_TARGET.lastIndex = 0;
  }
  return [...new Set(values)];
}

function balancedJsonValue(value: string): string | undefined {
  const opener = value[0];
  const closer = opener === "{" ? "}" : opener === "[" ? "]" : undefined;
  if (!closer) return undefined;
  let depth = 0;
  let quoted = false;
  let escaped = false;
  for (let index = 0; index < value.length; index++) {
    const char = value[index]!;
    if (quoted) {
      if (escaped) escaped = false;
      else if (char === "\\") escaped = true;
      else if (char === '"') quoted = false;
      continue;
    }
    if (char === '"') {
      quoted = true;
      continue;
    }
    if (char === opener) depth++;
    if (char === closer) depth--;
    if (depth !== 0) continue;
    const candidate = value.slice(0, index + 1);
    try {
      JSON.parse(candidate);
      return candidate;
    } catch {
      return undefined;
    }
  }
  return undefined;
}

function labelledContentValue(segment: string): string | undefined {
  const label = /(?:with\s+)?(?:(exact)\s+)?(?:json\s+)?content\s*(?::|=)?\s*|с\s+(?:(точн\S*)\s+)?(?:json\s+)?содержим\S*\s*(?::|=)?\s*/iu.exec(segment);
  if (!label) return undefined;
  const remainder = segment.slice((label.index ?? 0) + label[0].length).trimStart();
  if (!remainder) return undefined;
  if (remainder[0] === "{" || remainder[0] === "[") return balancedJsonValue(remainder);
  const quote = remainder[0];
  if (quote === '"' || quote === "'" || quote === "«" || quote === "`") {
    const closer = quote === "«" ? "»" : quote;
    const end = remainder.indexOf(closer, 1);
    return end > 0 ? remainder.slice(1, end) : undefined;
  }
  if (!label[1] && !label[2]) return undefined;
  return /^[^\s,.;:]+/u.exec(remainder)?.[0];
}

function replacementValues(segment: string): string[] {
  const token = String.raw`(?:"([^"\r\n]{1,2048})"|'([^'\r\n]{1,2048})'|«([^»\r\n]{1,2048})»|([^\s,.;:]{1,2048}))`;
  const match = new RegExp(`(?:replac(?:e|es|ed|ing)|замен\\S*)\\s+${token}\\s+(?:with|на)\\s+${token}`, "iu").exec(segment);
  if (!match) return [];
  const oldValue = normalizeValue(match[1] ?? match[2] ?? match[3] ?? match[4] ?? "");
  const newValue = normalizeValue(match[5] ?? match[6] ?? match[7] ?? match[8] ?? "");
  return oldValue && newValue ? [oldValue, newValue] : [];
}

function expectedValuesForAction(segment: string, operation: ActionMention["operation"]): string[] {
  if (operation === "create") {
    const content = labelledContentValue(segment);
    if (content !== undefined) return [normalizeValue(content)];
  }
  if (operation === "edit") {
    const replacement = replacementValues(segment);
    if (replacement.length > 0) return replacement;
  }
  return exactValues(segment);
}

function targetsIn(segment: string): string[] {
  FILE_TARGET.lastIndex = 0;
  return [...new Set([...segment.matchAll(FILE_TARGET)].map(match => normalizeValue(match[0])))];
}

function canonicalToolName(names: string[], pattern: RegExp): string | undefined {
  return names.find(name => pattern.test(name));
}

function explicitRequiredTool(text: string, position: number, allowedToolNames: string[]): string | undefined {
  const prefix = text.slice(Math.max(0, position - 64), position);
  return allowedToolNames.find(name => new RegExp(
    `(?:use|call|invoke|using|via|with|через|используя|используй(?:те)?|с\\s+помощью)\\s+${name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(?:\\s+(?:tool|инструмент))?\\s*[,;:]?\\s*(?:(?:to|for|чтобы|для)\\s*)?$`,
    "iu",
  ).test(prefix));
}

function commandLiteral(segment: string): string | undefined {
  const match = /`([^`\r\n]{1,2048})`/.exec(segment);
  return match?.[1]?.trim();
}

function namedToolInStep(body: string, allowedToolNames: string[]): string | undefined {
  const bare = body.replace(/^[`'"(«]+|[`'"),.;:»]+$/gu, "").trim();
  return allowedToolNames.find(name => bare.toLowerCase() === name.toLowerCase())
    ?? allowedToolNames.find(name => new RegExp(
      `(?:use|call|invoke|через|используя|используй(?:те)?|с\\s+помощью|using|via|with)\\s+${name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(?![\\p{L}\\p{N}_-])`,
      "iu",
    ).test(body));
}

function collapseDuplicateActionsInNamedSteps(
  planned: PlannedAction[],
  numberedSteps: NumberedPlanStep[],
  allowedToolNames: string[],
): PlannedAction[] {
  const collapsed: PlannedAction[] = [];
  for (const action of planned) {
    const step = numberedSteps.find(candidate => action.position >= candidate.bodyStart && action.position < candidate.end);
    if (!step || !namedToolInStep(step.body, allowedToolNames)) {
      collapsed.push(action);
      continue;
    }
    const duplicate = collapsed.find(candidate => (
      candidate.position >= step.bodyStart
      && candidate.position < step.end
      && candidate.kind === action.kind
      && candidate.operation === action.operation
      && (candidate.target ?? "") === (action.target ?? "")
    ));
    if (!duplicate) {
      collapsed.push(action);
      continue;
    }
    duplicate.expectedValues = [...new Set([...duplicate.expectedValues, ...action.expectedValues])];
    duplicate.requiredToolNames = [...new Set([...duplicate.requiredToolNames, ...action.requiredToolNames])];
  }
  return collapsed;
}

function bareNamedToolSteps(
  text: string,
  allowedToolNames: string[],
  sequenceGroup: string | undefined,
  planned: PlannedAction[],
  numberedSteps: NumberedPlanStep[],
): PlannedAction[] {
  const additions: PlannedAction[] = [];
  for (const step of numberedSteps) {
    const body = step.body;
    if (!body) continue;
    const toolName = namedToolInStep(body, allowedToolNames);
    if (!toolName) continue;
    if (planned.some(action => action.position >= step.bodyStart && action.position < step.end)) continue;
    additions.push({
      kind: "tool_execution",
      expectedValues: [],
      requiredToolNames: [toolName],
      position: step.bodyStart,
      sequenceGroup,
    });
  }
  return additions;
}

function planExplicitActions(text: string, allowedToolNames: string[]): PlannedAction[] {
  const mentions = actionMentions(text, allowedToolNames);
  const numberedSteps = structuredNumberedSteps(text);
  const planned: PlannedAction[] = [];
  let lastSingleTarget: string | undefined;
  let hasUnambiguousTarget = false;
  const sequential = numberedSteps.length >= 2 || SEQUENCE_CUE.test(text);
  const sequenceGroup = sequential ? `sequence:${digest(text)}` : undefined;

  for (const mention of mentions) {
    const segment = text.slice(mention.start, mention.end);
    const explicitTargets = targetsIn(segment);
    const required = explicitRequiredTool(text, mention.start, allowedToolNames);
    const values = expectedValuesForAction(segment, mention.operation);
    const targets: Array<string | undefined> = explicitTargets.length > 0
      ? explicitTargets
      : mention.operation === "edit" || mention.operation === "verify" || mention.operation === "delete"
        ? hasUnambiguousTarget ? [lastSingleTarget] : []
        : [];
    if (explicitTargets.length === 1) {
      lastSingleTarget = explicitTargets[0];
      hasUnambiguousTarget = true;
    } else if (explicitTargets.length > 1) {
      lastSingleTarget = undefined;
      hasUnambiguousTarget = false;
    }

    if (mention.operation === "command") {
      const command = commandLiteral(segment);
      planned.push({
        kind: "command_execution",
        expectedValues: command ? [command] : [],
        requiredToolNames: required ? [required] : [],
        position: mention.start,
        sequenceGroup,
      });
      continue;
    }

    if (mention.operation === "inspect" && targets.length === 0) {
      planned.push({
        kind: "environment_inspection",
        expectedValues: [],
        requiredToolNames: required ? [required] : [],
        position: mention.start,
        sequenceGroup,
      });
      continue;
    }

    if (targets.length === 0 && mention.operation === "create") {
      const hadPriorFileAction = planned.some(action => action.kind === "file_mutation" || action.kind === "file_verification");
      planned.push({
        kind: "file_mutation",
        operation: "create",
        expectedValues: values,
        requiredToolNames: required ? [required] : [],
        position: mention.start,
        sequenceGroup,
      });
      lastSingleTarget = undefined;
      hasUnambiguousTarget = !hadPriorFileAction;
      continue;
    }

    for (const target of targets) {
      planned.push({
        kind: mention.operation === "verify" || mention.operation === "inspect"
          ? "file_verification"
          : "file_mutation",
        operation: mention.operation === "inspect" ? "verify" : mention.operation,
        target,
        expectedValues: values,
        requiredToolNames: required ? [required] : [],
        position: mention.start,
        sequenceGroup,
      });
    }
  }

  const collapsed = collapseDuplicateActionsInNamedSteps(planned, numberedSteps, allowedToolNames);
  planned.length = 0;
  planned.push(...collapsed);
  planned.push(...bareNamedToolSteps(text, allowedToolNames, sequenceGroup, planned, numberedSteps));

  const latestExpectedByTarget = new Map<string, string[]>();
  for (const action of planned) {
    if (action.kind === "file_mutation") {
      if (action.operation === "create" && action.expectedValues.length > 0) {
        action.resultValues = [...action.expectedValues];
      } else if (action.operation === "edit" && action.expectedValues.length > 0) {
        action.resultValues = [action.expectedValues[action.expectedValues.length - 1]!];
      }
    }
    if (action.kind === "file_mutation" && action.target && action.expectedValues.length > 0) {
      latestExpectedByTarget.set(
        normalizedStandalonePath(action.target),
        action.resultValues ?? action.expectedValues,
      );
    }
    if (action.kind === "file_verification" && action.target && action.expectedValues.length === 0) {
      action.expectedValues = [...(latestExpectedByTarget.get(normalizedStandalonePath(action.target)) ?? [])];
    }
  }
  return planned;
}

function maskUntrustedToolSyntax(text: string): string {
  const mask = (value: string): string => value.replace(/[^\r\n]/gu, " ");
  const fenceMasked = maskMarkdownCodeFences(text, mask);
  const hasLegacyMarker = (fenceMasked.match(/[^\r\n]*/gu) ?? []).some(line => (
    /^(?:Action|Action Input|Calling|Tool)\s*:/iu.test(markdownFenceLine(line).body.trimStart())
  ));
  if (hasLegacyMarker) {
    return mask(fenceMasked);
  }
  const masked = fenceMasked
    .replace(/<bridge_tool_call>[\s\S]*?<\/bridge_tool_call>/giu, mask)
    .replace(/<bridge_plan_update>[\s\S]*?<\/bridge_plan_update>/giu, mask);
  return /<\/?bridge_(?:tool_call|plan_update)>/iu.test(masked) ? mask(masked) : masked;
}

interface MarkdownFenceLine {
  body: string;
  quoteDepth: number;
  listIndent: number;
}

function markdownFenceLine(body: string): MarkdownFenceLine {
  let remainder = body;
  let quoteDepth = 0;
  let listIndent = 0;
  while (true) {
    const previous = remainder;
    const quote = /^[ \t]{0,3}>[ \t]?/u.exec(remainder)?.[0];
    if (quote) {
      remainder = remainder.slice(quote.length);
      quoteDepth++;
      continue;
    }
    const list = /^[ \t]{0,3}(?:[-+*]|\d+[.)])[ \t]+/u.exec(remainder)?.[0];
    if (list) {
      remainder = remainder.slice(list.length);
      listIndent += list.length;
      continue;
    }
    if (remainder === previous) return { body: remainder, quoteDepth, listIndent };
  }
}

function markdownFenceClosingBody(body: string, quoteDepth: number): string | undefined {
  let remainder = body;
  for (let index = 0; index < quoteDepth; index++) {
    const quote = /^[ \t]{0,3}>[ \t]?/u.exec(remainder)?.[0];
    if (!quote) return undefined;
    remainder = remainder.slice(quote.length);
  }
  if (/^[ \t]{0,3}>/u.test(remainder)) return undefined;
  return remainder;
}

function maskMarkdownCodeFences(text: string, mask: (value: string) => string): string {
  let fence: {
    character: "`" | "~";
    length: number;
    quoteDepth: number;
    closingIndent: number;
  } | undefined;
  const lines = text.match(/[^\r\n]*(?:\r\n|\r|\n|$)/gu) ?? [];
  return lines.map(segment => {
    const body = segment.replace(/(?:\r\n|\r|\n)$/u, "");
    const delimiter = segment.slice(body.length);
    if (fence) {
      const closeBody = markdownFenceClosingBody(body, fence.quoteDepth);
      const close = new RegExp(
        `^[ \\t]{0,${fence.closingIndent}}${fence.character}{${fence.length},}[ \\t]*$`,
        "u",
      );
      const masked = mask(body) + delimiter;
      if (closeBody !== undefined && close.test(closeBody)) fence = undefined;
      return masked;
    }
    const line = markdownFenceLine(body);
    const opening = line.body.match(/^[ \t]{0,3}(`{3,}|~{3,})/u)?.[1];
    if (!opening) return segment;
    fence = {
      character: opening[0] as "`" | "~",
      length: opening.length,
      quoteDepth: line.quoteDepth,
      closingIndent: line.listIndent + 3,
    };
    return mask(body) + delimiter;
  }).join("");
}

function mutationAuthorityClause(segment: string): string {
  const boundary = /(?:^|[\s,;:])(?:from|using|based\s+on|according\s+to|derived\s+from|with\s+(?:the\s+)?(?:exact\s+)?(?:content|contents|data)|containing|из|используя|на\s+основе|согласно|с\s+(?:точн\S*\s+)?содержим\S*)(?=$|[\s,;:])/iu.exec(segment);
  return boundary ? segment.slice(0, boundary.index) : segment;
}

function declaredMutationTargetsInDiscovery(content: string, allowedToolNames: string[]): string[] {
  const safeContent = maskUntrustedToolSyntax(content);
  const targets: string[] = [];
  for (const mention of actionMentions(safeContent, allowedToolNames)) {
    if (mention.operation !== "create" && mention.operation !== "edit" && mention.operation !== "delete") continue;
    targets.push(...targetsIn(mutationAuthorityClause(safeContent.slice(mention.start, mention.end))));
  }
  return [...new Set(targets)];
}

function obligationTargets(obligation: ToolObligation): string[] {
  return obligation.argumentLiterals.filter(value => {
    FILE_TARGET.lastIndex = 0;
    return FILE_TARGET.test(value);
  });
}

function fallbackActions(text: string, allowedToolNames: string[], skipFileKinds: boolean): PlannedAction[] {
  const planned: PlannedAction[] = [];
  for (const obligation of inferToolObligations(text, allowedToolNames)) {
    if (skipFileKinds && (obligation.kind === "file_mutation" || obligation.kind === "file_verification")) continue;
    const targets = obligationTargets(obligation);
    const values = [...obligation.argumentLiterals, ...obligation.resultLiterals]
      .filter(value => !targets.includes(value));
    const eachTarget = targets.length > 0 && (obligation.kind === "file_mutation" || obligation.kind === "file_verification")
      ? targets
      : [undefined];
    for (const target of eachTarget) {
      planned.push({
        kind: obligation.kind,
        operation: obligation.kind === "file_verification" ? "verify" : undefined,
        target,
        expectedValues: values,
        requiredToolNames: obligation.requiredToolName ? [obligation.requiredToolName] : [],
        position: Number.MAX_SAFE_INTEGER,
        sequenceGroup: obligation.orderedActionGroup,
      });
    }
  }
  return planned;
}

export function currentActionText(messages: CanonicalMessage[]): { text: string; index: number } | undefined {
  for (let index = messages.length - 1; index >= 0; index--) {
    const message = messages[index]!;
    const text = message.parts
      .filter(part => part.type === "text")
      .map(part => part.text ?? "")
      .join("\n")
      .replace(/<system-reminder\b[^>]*>[\s\S]*?<\/system-reminder>/gi, "")
      .trim();
    if (message.role === "user" && text && !message.parts.some(part => part.type === "tool_result")) {
      return { text, index };
    }
  }
  return undefined;
}

export function actionTurnKey(request: CanonicalRequest): string {
  const current = currentActionText(request.messages);
  if (!current) return digest("empty-turn");
  return digest(`${current.index}\n${current.text.normalize("NFC")}`);
}

export function createActionLedger(
  request: CanonicalRequest,
  allowedTools: readonly string[] | readonly CanonicalTool[],
): ActionLedger {
  const allowedToolNames = allowedTools.map(tool => typeof tool === "string" ? tool : tool.name);
  const current = currentActionText(request.messages);
  const text = current?.text ?? "";
  const explicit = planExplicitActions(text, allowedToolNames);
  const explicitKinds = new Set(explicit.map(action => action.kind));
  const numberedSteps = structuredNumberedSteps(text);
  const fallback = fallbackActions(text, allowedToolNames, true)
    .filter(action => !explicitKinds.has(action.kind))
    .filter(action => !(numberedSteps.length >= 2
      && action.kind === "command_execution"
      && !explicit.some(candidate => candidate.kind === "command_execution")));
  let planned = [...explicit, ...fallback]
    .sort((left, right) => left.position - right.position);
  if (planned.length === 0) {
    const namedTools = allowedToolNames.filter(name => new RegExp(
      `(?<![\\p{L}\\p{N}_-])${name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(?![\\p{L}\\p{N}_-])`,
      "iu",
    ).test(text));
    const directNamedToolRequest = /(?:^|[.!?]\s*)(?:please\s+)?(?:use|call|run|execute|process)\b|(?:using|with|via|через|используя|с\s+помощью)\s+\S+/iu.test(text);
    if (namedTools.length === 1 && directNamedToolRequest) {
      planned = [{
        kind: "tool_execution",
        expectedValues: [],
        requiredToolNames: namedTools,
        position: 0,
      }];
    }
  }
  if (planned.length === 0 && looksLikeEnvironmentDataRequest(text, allowedToolNames)) {
    planned = [{
      kind: "environment_inspection",
      expectedValues: [],
      requiredToolNames: [],
      position: 0,
    }];
  }

  const actions: LedgerAction[] = [];
  const previousByGroup = new Map<string, string>();
  for (const [index, item] of planned.entries()) {
    const actionId = `act_${index + 1}_${digest(`${text}\n${item.position}\n${item.kind}\n${item.operation ?? ""}\n${item.target ?? ""}`)}`;
    const dependencies: string[] = [];
    if (item.sequenceGroup) {
      const previous = previousByGroup.get(item.sequenceGroup);
      if (previous) dependencies.push(previous);
      previousByGroup.set(item.sequenceGroup, actionId);
    }
    actions.push({
      actionId,
      kind: item.kind,
      operation: item.operation,
      target: item.target,
      expectedValues: [...item.expectedValues],
      ...(item.resultValues ? { resultValues: [...item.resultValues] } : {}),
      dependencies,
      requiredToolNames: [...item.requiredToolNames],
      mandatory: true,
      status: "pending",
      failedFingerprints: [],
      source: "inferred",
      description: `${item.operation ?? item.kind}${item.target ? ` target=${JSON.stringify(item.target)}` : ""}`,
      createdRevision: 0,
      opensDiscovery: false,
      evidenceCallIds: [],
    });
  }

  const workspaceRoot = workspaceRootFromSystem(request.system);
  const unresolvedIntent = planned.length === 0 && looksLikeExternalActionRequest(text, allowedToolNames);
  return {
    version: 4,
    turnKey: actionTurnKey(request),
    ...(workspaceRoot ? { workspaceRoot } : {}),
    actions,
    unresolvedIntent,
    callLedger: createCallLedger(),
    plan: createExecutionPlanState(),
    taskPolicy: createTaskPolicy(actions, allowedTools, workspaceRoot, unresolvedIntent, Date.now(), text),
    updatedAt: Date.now(),
  };
}

function dependenciesSucceeded(ledger: ActionLedger, action: LedgerAction): boolean {
  return action.dependencies.every(id => ledger.actions.find(candidate => candidate.actionId === id)?.status === "succeeded");
}

export function executableLedgerActions(ledger: ActionLedger): LedgerAction[] {
  return ledger.actions.filter(action => (
    action.mandatory
    && (action.status === "pending" || action.status === "failed" || action.status === "stale")
    && dependenciesSucceeded(ledger, action)
  ));
}

export function outstandingLedgerActions(ledger: ActionLedger): LedgerAction[] {
  return ledger.actions.filter(action => action.mandatory && action.status !== "succeeded");
}

export function ledgerComplete(ledger: ActionLedger): boolean {
  return !ledger.unresolvedIntent && !ledger.plan.awaitingUpdate && outstandingLedgerActions(ledger).length === 0;
}

function toolMatchesKind(action: LedgerAction, toolCall: CanonicalToolCall): boolean {
  const name = toolCall.name.toLowerCase();
  if (action.requiredToolNames.length > 0
    && !action.requiredToolNames.some(required => required.toLowerCase() === name)) return false;
  if (action.kind === "file_mutation") {
    if (action.operation === "create") return /^(?:write|create)$/i.test(name) || action.requiredToolNames.some(required => /bash|shell|command/i.test(required));
    if (action.operation === "edit") return /^(?:edit)$/i.test(name);
    if (action.operation === "delete") return /^(?:delete|remove)$/i.test(name) || action.requiredToolNames.some(required => /bash|shell|command/i.test(required));
    return /write|edit|create|delete|remove/i.test(name);
  }
  if (action.kind === "file_verification") return /^(?:read|cat)$/i.test(name)
    || action.requiredToolNames.some(required => required.toLowerCase() === name);
  if (action.kind === "environment_inspection") {
    if (/^(?:glob|grep|read|cat|find|list)/i.test(name)) return true;
    const command = commandArgument(toolCall);
    return /bash|shell|powershell|terminal|command|exec/i.test(name) && Boolean(command && isConfidentlyReadOnlyCommand(command));
  }
  if (action.kind === "command_execution") return /bash|shell|powershell|terminal|command|exec/i.test(name);
  if (action.kind === "tool_execution") return action.requiredToolNames.some(required => required.toLowerCase() === name);
  if (action.kind === "test_execution") return /bash|shell|powershell|terminal|command|exec/i.test(name);
  if (action.kind === "dependency_install") return /bash|shell|powershell|terminal|command|exec|install|package/i.test(name);
  if (action.kind === "launch") return /bash|shell|powershell|terminal|command|exec|browser|open|launch/i.test(name);
  if (action.kind === "api_verification" || action.kind === "server_verification") {
    return /bash|shell|powershell|terminal|command|exec|fetch|http/i.test(name);
  }
  return /bash|shell|powershell|terminal|command|exec/i.test(name);
}

function toolMatchesTarget(ledger: ActionLedger, action: LedgerAction, toolCall: CanonicalToolCall): boolean {
  const targets = pathArguments(toolCall);
  if (!action.target) {
    return targets.length === 0 || targets.every(target => resolvedWorkspacePath(ledger.workspaceRoot, target) !== undefined);
  }
  if (targets.some(target => sameTarget(ledger.workspaceRoot, action.target!, target))) return true;
  const command = commandArgument(toolCall);
  if (!command || !action.requiredToolNames.some(required => /bash|shell|command|terminal/i.test(required))) return false;
  const commandTargets = targetsIn(command);
  return commandTargets.some(target => sameTarget(ledger.workspaceRoot, action.target!, target));
}

function toolMatchesExpectedValues(action: LedgerAction, toolCall: CanonicalToolCall): boolean {
  if (action.expectedValues.length === 0) return true;
  if (action.kind === "file_verification") return true;
  let values: string[];
  if (action.kind === "file_mutation" && action.operation === "create") {
    values = typeof toolCall.arguments.content === "string" ? [toolCall.arguments.content] : [];
  } else if (action.kind === "file_mutation" && action.operation === "edit") {
    values = [toolCall.arguments.old_string, toolCall.arguments.new_string]
      .filter((value): value is string => typeof value === "string");
  } else {
    const command = commandArgument(toolCall);
    values = command ? [command] : [];
  }
  const normalized = values.map(normalizeValue);
  return action.expectedValues.every(expected => normalized.includes(normalizeValue(expected)));
}

export function admitLedgerToolCall(ledger: ActionLedger, toolCall: CanonicalToolCall): LedgerAdmission {
  const fingerprint = toolCallFingerprint(toolCall.name, toolCall.arguments);
  const executable = executableLedgerActions(ledger);
  for (const action of executable) {
    if (action.source === "plan" && action.kind === "file_mutation" && action.status === "stale") continue;
    if (action.failedFingerprints.includes(fingerprint)) return { allowed: false, reason: "repeated_failure" };
    if (action.source === "plan") {
      if (dynamicPlanActionMatchesTool(ledger.workspaceRoot, action, toolCall, ledger.taskPolicy)) {
        return { allowed: true, actionId: action.actionId, reason: "matched" };
      }
      continue;
    }
    if (!toolMatchesKind(action, toolCall)) continue;
    if (!toolMatchesTarget(ledger, action, toolCall)) continue;
    if (!toolMatchesExpectedValues(action, toolCall)) continue;
    return { allowed: true, actionId: action.actionId, reason: "matched" };
  }
  const unfinished = outstandingLedgerActions(ledger);
  if (unfinished.length === 0) return { allowed: false, reason: "duplicate" };
  if (ledger.actions.some(action => action.status === "succeeded"
    && (action.source === "plan"
      ? dynamicPlanActionMatchesTool(ledger.workspaceRoot, action, toolCall, ledger.taskPolicy)
      : toolMatchesKind(action, toolCall)
        && toolMatchesTarget(ledger, action, toolCall)
        && toolMatchesExpectedValues(action, toolCall)))) {
    return { allowed: false, reason: "duplicate" };
  }
  if (unfinished.some(action => (action.source === "plan"
    ? dynamicPlanActionMatchesTool(ledger.workspaceRoot, action, toolCall, ledger.taskPolicy)
    : toolMatchesKind(action, toolCall)
      && toolMatchesTarget(ledger, action, toolCall)
      && toolMatchesExpectedValues(action, toolCall))
    && !dependenciesSucceeded(ledger, action))) {
    return { allowed: false, reason: "blocked_dependency" };
  }
  if (unfinished.some(action => action.source === "plan"
    ? action.requiredToolNames.some(name => name.toLowerCase() === toolCall.name.toLowerCase())
    : toolMatchesKind(action, toolCall))) return { allowed: false, reason: "wrong_target" };
  return { allowed: false, reason: ledger.actions.length === 0 ? "no_action" : "wrong_tool" };
}

function bindDeferredTargets(ledger: ActionLedger, completed: LedgerAction, target: string | undefined): void {
  if (!target) return;
  completed.target ??= target;
  for (const action of ledger.actions) {
    if (action.target || !action.dependencies.includes(completed.actionId)) continue;
    if (action.kind === "file_verification" || action.kind === "file_mutation") action.target = target;
  }
}

export function markLedgerActionRunning(
  ledger: ActionLedger,
  actionId: string,
  callId: string,
  toolCall: CanonicalToolCall,
): void {
  const action = ledger.actions.find(candidate => candidate.actionId === actionId);
  if (!action
    || !dependenciesSucceeded(ledger, action)
    || !["pending", "failed", "stale"].includes(action.status)
    || activeCallForAction(ledger.callLedger, actionId)) {
    throw new Error("Ledger action is not executable.");
  }
  const target = pathArguments(toolCall)[0];
  const resolvedTarget = target ? resolvedWorkspacePath(ledger.workspaceRoot, target) : undefined;
  bindDeferredTargets(ledger, action, resolvedTarget ?? target);
  if (action.kind === "file_mutation") {
    const resultingValue = action.operation === "edit"
      ? toolCall.arguments.new_string
      : action.operation === "create"
        ? toolCall.arguments.content
        : undefined;
    if ((!action.resultValues || action.resultValues.length === 0) && typeof resultingValue === "string") {
      action.resultValues = [normalizeValue(resultingValue)];
    }
  }
  proposeCall(
    ledger.callLedger,
    actionId,
    { ...toolCall, id: callId },
    Date.now(),
    action.createdRevision,
  );
  if (!markCallExposed(ledger.callLedger, callId)) {
    throw new Error("Ledger call could not be exposed.");
  }
  action.status = "running";
  ledger.updatedAt = Date.now();
}

function resultFailed(content: string): boolean {
  if (/\b(?:ENOENT|EACCES|EPERM|permission denied|command failed|non[- ]?zero exit|failed to|error:)\b/i.test(content)) return true;
  try {
    const parsed = JSON.parse(content) as Record<string, unknown>;
    return parsed.is_error === true || parsed.error !== undefined || parsed.success === false || (typeof parsed.exit_code === "number" && parsed.exit_code !== 0);
  } catch {
    return false;
  }
}

export function applyLedgerToolResult(
  ledger: ActionLedger,
  callId: string,
  content: string,
  isError: boolean,
): boolean {
  const call = findCallRecord(ledger.callLedger, callId);
  if (!call) return false;
  const action = ledger.actions.find(candidate => candidate.actionId === call.actionId);
  const activeCall = activeCallForAction(ledger.callLedger, call.actionId);
  const recoverableInterrupted = call.status === "interrupted"
    && !activeCall
    && (action?.status === "pending" || action?.status === "stale");
  if (!action || (action.status !== "running" && !recoverableInterrupted)) return false;
  if (action.status === "running" && activeCall?.callId !== callId) return false;
  const failed = isError || resultFailed(content);
  const received = recordCallResult(ledger.callLedger, callId, isError);
  if (!received) return false;
  if (failed) {
    action.status = "failed";
    if (!action.failedFingerprints.includes(call.fingerprint)) {
      action.failedFingerprints.push(call.fingerprint);
    }
  } else if (action.kind === "file_verification" && !verificationResultMatches(ledger, action, content)) {
    action.status = "failed";
    if (!action.failedFingerprints.includes(call.fingerprint)) {
      action.failedFingerprints.push(call.fingerprint);
    }
  } else {
    action.status = "succeeded";
    if (action.kind === "file_mutation" && action.target) {
      const mutationIndex = ledger.actions.indexOf(action);
      const hasLaterVerification = ledger.actions.some((candidate, index) => (
        index > mutationIndex
        && candidate.kind === "file_verification"
        && candidate.status !== "succeeded"
        && Boolean(candidate.target && sameTarget(ledger.workspaceRoot, action.target!, candidate.target))
      ));
      for (const candidate of ledger.actions) {
        if (candidate.kind !== "file_verification"
          || !candidate.target
          || !sameTarget(ledger.workspaceRoot, action.target, candidate.target)) continue;
        if (candidate.status === "succeeded" && !hasLaterVerification) {
          candidate.status = "stale";
          if (!candidate.dependencies.includes(action.actionId)) candidate.dependencies.push(action.actionId);
        }
        const resultingValues = action.resultValues ?? action.expectedValues;
        if (resultingValues.length > 0
          && transitivelyDependsOnAction(ledger, candidate, action.actionId)) {
          candidate.expectedValues = [...resultingValues];
        }
      }
    }
    if (action.opensDiscovery) {
      action.resultValues = declaredMutationTargetsInDiscovery(
        content,
        ledger.taskPolicy.tools.map(tool => tool.name),
      );
    }
    if (action.opensDiscovery) requireExecutionPlanUpdate(ledger, callId);
  }
  finalizeCall(ledger.callLedger, callId, failed ? "failed" : "succeeded");
  if (!action.evidenceCallIds.includes(callId)) action.evidenceCallIds.push(callId);
  ledger.updatedAt = Date.now();
  return true;
}

export function replayLedgerToolResults(ledger: ActionLedger, messages: CanonicalMessage[]): void {
  const toolCalls = new Map<string, CanonicalToolCall>();
  const toolResultIds = new Set<string>();
  for (const message of messages) {
    for (const part of message.parts) {
      if (part.type === "tool_result" && part.toolResult) toolResultIds.add(part.toolResult.toolUseId);
    }
  }
  for (const message of messages) {
    for (const part of message.parts) {
      if (part.type === "tool_use" && part.toolCall) {
        toolCalls.set(part.toolCall.id, part.toolCall);
        if (!findCallRecord(ledger.callLedger, part.toolCall.id) && toolResultIds.has(part.toolCall.id)) {
          const admission = admitLedgerToolCall(ledger, part.toolCall);
          if (admission.allowed && admission.actionId) {
            markLedgerActionRunning(ledger, admission.actionId, part.toolCall.id, part.toolCall);
          }
        }
      }
      if (part.type === "tool_result" && part.toolResult) {
        applyLedgerToolResult(
          ledger,
          part.toolResult.toolUseId,
          part.toolResult.content,
          part.toolResult.isError === true,
        );
      }
    }
  }
}

export function ledgerActionDescription(action: LedgerAction): string {
  if (action.source === "plan") return action.description;
  const operation = action.operation ?? action.kind;
  const target = action.target ? ` target=${JSON.stringify(action.target)}` : "";
  const values = action.expectedValues.length > 0 ? ` expected=${JSON.stringify(action.expectedValues)}` : "";
  const tool = action.requiredToolNames.length > 0 ? ` tool=${JSON.stringify(action.requiredToolNames)}` : "";
  return `${operation}${target}${values}${tool}`;
}

export function ledgerActionToolNames(action: LedgerAction, allowedToolNames: string[]): string[] {
  if (action.requiredToolNames.length > 0) {
    return allowedToolNames.filter(name => action.requiredToolNames.some(required => required.toLowerCase() === name.toLowerCase()));
  }
  const pattern = action.kind === "file_mutation"
    ? action.operation === "create"
      ? /^(?:write|create)$/i
      : action.operation === "edit"
        ? /^edit$/i
        : action.operation === "delete"
          ? /^(?:delete|remove)$/i
          : /^(?:write|edit|create|delete|remove)$/i
    : action.kind === "file_verification"
      ? /^(?:read|cat)$/i
      : action.kind === "environment_inspection"
        ? /^(?:glob|grep|read|cat|find|list|bash|shell|powershell|terminal|command|exec)$/i
        : /^(?:bash|shell|powershell|terminal|command|exec|install|package|browser|open|launch|fetch|http)$/i;
  return allowedToolNames.filter(name => pattern.test(name));
}

export function cloneActionLedger(ledger: ActionLedger): ActionLedger {
  return structuredClone(ledger);
}

export function recoverRestoredActionLedger(ledger: ActionLedger): ActionLedger {
  const restored = cloneActionLedger(ledger);
  const interruptedCalls = interruptOpenCalls(restored.callLedger);
  let changed = interruptedCalls.length > 0;
  for (const action of restored.actions) {
    if (action.status !== "running") continue;
    changed = true;
    action.status = action.kind === "file_mutation" ? "stale" : "pending";
    delete action.resultValues;
  }
  if (changed) restored.updatedAt = Date.now();
  return restored;
}
