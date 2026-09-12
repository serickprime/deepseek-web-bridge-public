import { isDeepStrictEqual } from "node:util";
import path from "node:path";
import type { CanonicalTool } from "../api/canonical.js";
import { isRecord } from "../utils/json.js";
import { isInformationalRequest } from "./toolParser.js";

export type TaskPolicyMutationOperation = "create" | "edit" | "delete";

export interface TaskPolicyRequirement {
  kind: string;
  operation?: string;
  target?: string;
  expectedValues: string[];
  requiredToolNames: string[];
}

export interface TaskPolicyTool {
  name: string;
  inputSchema?: Record<string, unknown>;
}

export interface TaskPolicy {
  version: 1;
  workspaceRoot?: string;
  tools: TaskPolicyTool[];
  requirements: TaskPolicyRequirement[];
  mutationScope: "denied" | "exact" | "workspace";
  mutationTargets: string[];
  mutationTargetsRequireDiscoveryEvidence: boolean;
  readScope: "exact" | "workspace";
  readTargets: string[];
  explicitToolNames: string[];
  explicitCommands: string[];
  delegatedValidationCommands: boolean;
  createdAt: number;
}

export interface TaskPolicySourceAction {
  kind: string;
  operation?: string;
  target?: string;
  expectedValues: string[];
  requiredToolNames: string[];
}

export interface TaskPolicyPlanStep {
  id?: string;
  kind: "discovery" | "mutation" | "verification" | "validation" | "action";
  requiredToolNames: string[];
  expectedArguments: Record<string, unknown>;
  dependencies?: string[];
  opensDiscovery?: boolean;
}

export type TaskPolicyRejectionReason =
    | "ambiguous_tool"
    | "tool_catalog_changed"
    | "workspace_unknown"
    | "unsafe_arguments"
    | "unsafe_command"
    | "mutation_not_authorized"
    | "target_not_authorized"
    | "value_not_authorized"
    | "tool_not_authorized"
    | "required_action_missing";

export type TaskPolicyDecision =
  | { allowed: true; reason: "allowed" }
  | { allowed: false; reason: TaskPolicyRejectionReason };

const PATH_KEYS = new Set([
  "cwd",
  "directory",
  "dir",
  "file",
  "filename",
  "file_path",
  "path",
  "root",
  "target",
]);
const SHELL_TOOL = /bash|shell|powershell|terminal|command|exec/i;
const MUTATION_TOOL = /^(?:write|edit|create|delete|remove)$/i;
const READ_TOOL = /^(?:read|cat|glob|grep|find|list)$/i;
const COMMAND_ACTION_KIND = /^(?:command_execution|test_execution|dependency_install|launch|api_verification|server_verification)$/;
const EXPLICIT_READ_ONLY = /(?:\bread[- ]?only\b|\bwithout\s+(?:any\s+)?changes\b|\bdo\s+not\s+(?:change|modify|write|edit|delete|create)\b|\bdon't\s+(?:change|modify|write|edit|delete|create)\b|ничего\s+не\s+(?:изменяй|меняй|создавай|записывай|удаляй)|не\s+(?:изменяй|меняй|создавай|записывай|удаляй)(?![\p{L}\p{N}_-])|только\s+(?:прочитай|читай|посмотри|изучи|проверь))/iu;
const GLOBAL_MUTATION_DENIAL = /(?:\bread[- ]?only\b|\bwithout\s+(?:any\s+)?changes\b|\b(?:do\s+not|don't|never)\s+(?:change|modify|write|edit|delete|create)\s+(?:anything|(?:any\s+)?files?\b(?!\s+(?:outside|except|other\s+than))|the\s+(?:project|workspace|repository|repo|codebase)|this\s+(?:project|workspace|repository|repo|codebase))|ничего\s+не\s+(?:изменяй|меняй|создавай|записывай|удаляй)|не\s+(?:изменяй|меняй|создавай|записывай|удаляй)\s+(?:ничего|никакие\s+файлы|все\s+файлы|файлы|проект|рабочую\s+папку|репозиторий)|только\s+(?:прочитай|читай|посмотри|изучи|проверь))/iu;
const UNRELATED_MUTATION_DENIAL = /(?:\b(?:do\s+not|don't|never)\s+(?:create|write|add)\s+(?:(?:any|the)\s+)?(?:(?:unrelated|other|additional|extra)\s+files?|files?\s+outside\s+(?:the\s+)?(?:requirements?|scope))\b|не\s+(?:создавай|создавать|записывай|записывать|добавляй|добавлять)\s+(?:другие|посторонние|лишние|дополнительные|не\s+связанные)\s+файлы)/iu;
const MUTATION_INTENT = /(?:\b(?:implement|apply|execute|follow|fix|build|develop|generate|transform|convert|process|produce|refactor|update|create|write|edit|modify|change|save|delete|remove|install)\b|(?:реализ|примен|выполн|следу|исправ|созда|сдела|разработ|сгенер|преобраз|конверт|обработ|подготов|переработ|обнов|запиш|сохран|измен|отредактир|удал|установ))/iu;
const WORKSPACE_SCOPE_INTENT = /(?:\b(?:(?:all|every)\s+(?:required\s+changes?|mandatory\s+(?:requirements?|instructions?)|requirements?|instructions?|related\s+(?:source|project|code|files?)|listed\s+(?:inputs?|files?)|produced\s+(?:artifacts?|files?)|project\s+files?)|(?:complete|entire|whole)\s+(?:project|website|site|codebase|workspace|repository|task)|related\s+(?:source|project|code|files?)|codebase|workspace|repository|repo)\b|(?:(?:все|кажд)\S*\s+(?:необходим\S*\s+(?:измен|требован|инструкц)|обязательн\S*\s+(?:требован|инструкц)|требован|инструкц|связанн\S*\s+(?:исходник|файл|код)|перечисленн\S*\s+(?:вход|файл)|созданн\S*\s+(?:артефакт|файл))|(?:полн|цел)\S*\s+(?:проект|сайт|задач)|связанн\S*\s+(?:исходник|файл|код)|кодов(?:ая|ую)\s+баз|рабоч(?:ая|ей)\s+папк|репозитор))/iu;
const PROJECT_WIDE_MUTATION_INTENT = /(?:\b(?:implement|apply|execute|follow|fix|build|develop|refactor|update|modify|change|create|generate|produce|write|rewrite)\b\s+(?:(?:the|a|an|this)\s+)?(?:(?:complete|entire|whole)\s+)?(?:project|website|site|application|app|codebase|workspace|repository|repo|code)\b(?!\.[\p{L}\p{N}_-]|[/\\])|\b(?:implement|apply|execute|follow|fix|build|develop|refactor|update|modify|change)\b\s+(?:all|every)\s+(?:(?:required|mandatory)\s+)?(?:changes?|requirements?|instructions?|artifacts?)\b|\b(?:implement|apply|fix|refactor|update|modify|change)\b\s+(?:all\s+)?related\s+(?:source|project|code|files?)\b|(?:реализ|примен|выполн|следу|исправ|разработ|переработ|обнов|измен|отредактир|созда|сдела|сгенер|подготов)\S*\s+(?:(?:весь|всю|все|полный|полную|целый|целую)\s+)?(?:проект|сайт|приложен|кодовую\s+базу|рабочую\s+папку|репозитор|код)(?!\.[\p{L}\p{N}_-]|[/\\])|(?:реализ|примен|выполн|следу|исправ|переработ|обнов|измен|отредактир)\S*\s+(?:все|кажд)\S*\s+(?:(?:необходим|обязательн)\S*\s+)?(?:измен|требован|инструкц|артефакт)\S*|(?:реализ|исправ|переработ|обнов|измен|отредактир)\S*\s+(?:все\s+)?связанн\S*\s+(?:исходник|файл|код)\S*)/iu;
const DELEGATED_COLLECTION_MUTATION_INTENT = /(?:\b(?:process|transform|convert)\b\s+(?:all|every)\s+listed\b|\buse\b[^.!?\r\n]{0,80}\bskill\b[^.!?\r\n]{0,80}\b(?:transform|convert|process|produce|generate|create|write|edit|modify|change)\b|(?:использ|примен)\S*[^.!?\r\n]{0,80}\bskill\b[^.!?\r\n]{0,80}(?:преобраз|обработ|подготов|переработ|созда|сгенер|запиш|измен)\S*)/iu;
const NON_EXECUTABLE_MUTATION_REFERENCE = /(?:\b(?:explain|describe|identify|discuss|recommend|suggest|tell)\b[^.!?\r\n]{0,160}\b(?:should|could|would|might|may)\b[^.!?\r\n]{0,80}\b(?:implement|fix|build|develop|refactor|update|modify|change|create|write|edit|delete|remove)\b|(?:объясн|опиш|расскаж|перечисл|предлож|порекоменд)\S*[^.!?\r\n]{0,160}(?:следует|нужно|можно|стоит|мог)\S*[^.!?\r\n]{0,80}(?:реализ|исправ|созда|сдела|разработ|обнов|запиш|измен|отредактир|удал)\S*)/iu;
const MUTATION_BINDING_VERB = /(?:\b(?:implement|fix|build|develop|generate|transform|convert|process|produce|refactor|update|create|write|edit|modify|change|save|delete|remove|install)\b|(?:реализ|исправ|созда|сдела|разработ|сгенер|преобраз|конверт|обработ|подготов|переработ|обнов|запиш|сохран|измен|отредактир|удал|установ))/iu;
const DELEGATED_VALIDATION_INTENT = /(?:\b(?:run|execute|perform)\b[^.!?\r\n]{0,80}\b(?:validation|check|tests?|verification)\b|(?:запуст|выполн|провед)\S*[^.!?\r\n]{0,80}(?:провер|валидац|тест))/iu;
const DELEGATED_REQUIREMENTS_INTENT = /(?:\b(?:follow|execute|apply)\b\s+(?:all|every)\s+(?:(?:mandatory|required)\s+)?(?:requirements?|instructions?)\b|(?:выполн|следу|примен)\S*\s+(?:все|кажд)\S*\s+(?:(?:обязательн|необходим)\S*\s+)?(?:требован|инструкц)\S*)/iu;

function intentClauses(intentText: string): string[] {
  return intentText
    .split(/(?:\.(?=\s|$)|[!?;\r\n]+|\b(?:but|however)\b|\s+но\s+|при\s+этом)/iu)
    .map(value => value.trim())
    .filter(Boolean);
}

function hasAffirmativeMutationIntent(intentText: string): boolean {
  return intentClauses(intentText).some(clause => (
    MUTATION_INTENT.test(clause)
    && !EXPLICIT_READ_ONLY.test(clause)
    && !isInformationalRequest(clause)
    && !NON_EXECUTABLE_MUTATION_REFERENCE.test(clause)
  ));
}

function normalize(value: string): string {
  return value.normalize("NFC").trim();
}

function isWindowsPath(value: string): boolean {
  return /^[a-z]:[\\/]/i.test(value) || /^\\\\/.test(value);
}

function pathApi(value: string): typeof path.posix {
  return isWindowsPath(value) ? path.win32 : path.posix;
}

export function resolveTaskPolicyPath(workspaceRoot: string | undefined, value: string): string | undefined {
  if (!workspaceRoot) return undefined;
  const api = pathApi(workspaceRoot);
  const root = api.resolve(workspaceRoot);
  const resolved = api.resolve(root, normalize(value));
  const relative = api.relative(root, resolved);
  if (relative === ".." || relative.startsWith(`..${api.sep}`) || api.isAbsolute(relative)) return undefined;
  const normalized = api.normalize(resolved);
  return api === path.win32 ? normalized.toLowerCase() : normalized;
}

function normalizedPolicyTarget(workspaceRoot: string | undefined, value: string | undefined): string | undefined {
  if (!value) return undefined;
  return resolveTaskPolicyPath(workspaceRoot, value);
}

function unique(values: string[]): string[] {
  return [...new Set(values.map(normalize).filter(Boolean))];
}

function explicitlyBindsMutationTarget(intentText: string, target: string): boolean {
  const escapedTarget = normalize(target).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  if (!escapedTarget) return false;
  const forwardBinding = new RegExp(
    `${MUTATION_BINDING_VERB.source}[^.!?\\r\\n]{0,120}${escapedTarget}`,
    "iu",
  );
  return forwardBinding.test(intentText);
}

function catalog(tools: readonly string[] | readonly CanonicalTool[]): TaskPolicyTool[] {
  return tools.map(tool => typeof tool === "string"
    ? { name: tool }
    : { name: tool.name, inputSchema: structuredClone(tool.inputSchema) });
}

export function createTaskPolicy(
  actions: readonly TaskPolicySourceAction[],
  tools: readonly string[] | readonly CanonicalTool[],
  workspaceRoot: string | undefined,
  unresolvedIntent: boolean,
  now = Date.now(),
  intentText = "",
): TaskPolicy {
  const actionableMutationIntent = hasAffirmativeMutationIntent(intentText);
  const taskWideReadOnly = GLOBAL_MUTATION_DENIAL.test(intentText);
  const hasTargetBoundMutation = actions.some(action => action.kind === "file_mutation" && action.target);
  const workspaceMutationPermission = !taskWideReadOnly && actionableMutationIntent
    && (PROJECT_WIDE_MUTATION_INTENT.test(intentText)
      || (!hasTargetBoundMutation && DELEGATED_COLLECTION_MUTATION_INTENT.test(intentText)));
  const workspaceReadPermission = unresolvedIntent || WORKSPACE_SCOPE_INTENT.test(intentText);
  const requirements = actions.map(action => ({
    kind: action.kind,
    ...(action.operation ? { operation: action.operation } : {}),
    ...(action.target
      && !(workspaceMutationPermission
        && action.kind === "file_mutation"
        && !explicitlyBindsMutationTarget(intentText, action.target))
      ? { target: normalizedPolicyTarget(workspaceRoot, action.target) ?? action.target }
      : {}),
    expectedValues: unique(action.expectedValues),
    requiredToolNames: unique(action.requiredToolNames),
  }));
  const mutations = requirements.filter(action => action.kind === "file_mutation");
  const mutationTargets = unique(mutations
    .map(action => normalizedPolicyTarget(workspaceRoot, action.target))
    .filter((value): value is string => Boolean(value)));
  const targetlessMutation = mutations.some(action => !action.target);
  const readTargets = unique(requirements
    .filter(action => action.kind === "file_verification" || action.kind === "file_mutation")
    .map(action => normalizedPolicyTarget(workspaceRoot, action.target))
    .filter((value): value is string => Boolean(value)));
  const workspaceRead = unresolvedIntent || requirements.some(action => (
    action.kind === "environment_inspection"
    || ((action.kind === "file_verification" || action.kind === "file_mutation") && !action.target)
  ));
  const explicitToolNames = unique(requirements.flatMap(action => action.requiredToolNames));
  const explicitCommands = unique(requirements
    .filter(action => COMMAND_ACTION_KIND.test(action.kind)
      || action.requiredToolNames.some(name => SHELL_TOOL.test(name)))
    .flatMap(action => action.expectedValues));
  const delegatedValidationCommands = !taskWideReadOnly
    && ((!isInformationalRequest(intentText) && DELEGATED_VALIDATION_INTENT.test(intentText))
      || (actionableMutationIntent && DELEGATED_REQUIREMENTS_INTENT.test(intentText)));
  return {
    version: 1,
    ...(workspaceRoot ? { workspaceRoot } : {}),
    tools: catalog(tools),
    requirements,
    mutationScope: workspaceMutationPermission
      ? "workspace"
      : mutations.length === 0
        ? "denied"
        : "exact",
    mutationTargets,
    mutationTargetsRequireDiscoveryEvidence: workspaceMutationPermission
      && UNRELATED_MUTATION_DENIAL.test(intentText),
    readScope: workspaceRead || workspaceReadPermission || targetlessMutation || actionableMutationIntent
      ? "workspace"
      : "exact",
    readTargets,
    explicitToolNames,
    explicitCommands,
    delegatedValidationCommands,
    createdAt: now,
  };
}

function isPathKey(key: string): boolean {
  const normalized = key.toLowerCase();
  return PATH_KEYS.has(normalized)
    || /(?:^|_)(?:file|path|dir|directory)$/.test(normalized);
}

function pathArgumentsStayInWorkspace(
  workspaceRoot: string | undefined,
  value: unknown,
  key = "",
): boolean {
  if (typeof value === "string") {
    return !isPathKey(key) || resolveTaskPolicyPath(workspaceRoot, value) !== undefined;
  }
  if (Array.isArray(value)) return value.every(item => pathArgumentsStayInWorkspace(workspaceRoot, item, key));
  if (!value || typeof value !== "object") return true;
  return Object.entries(value as Record<string, unknown>)
    .every(([nestedKey, item]) => pathArgumentsStayInWorkspace(workspaceRoot, item, nestedKey));
}

function targetFromArguments(
  workspaceRoot: string | undefined,
  args: Record<string, unknown>,
): string | undefined {
  for (const key of ["file_path", "path", "filename", "file", "directory", "dir", "target", "cwd"]) {
    const value = args[key];
    if (typeof value !== "string") continue;
    return resolveTaskPolicyPath(workspaceRoot, value);
  }
  return undefined;
}

function commandFromArguments(args: Record<string, unknown>): string | undefined {
  const value = args.command ?? args.cmd;
  return typeof value === "string" ? normalize(value) : undefined;
}

function delegatedValidationTarget(command: string): string | undefined {
  if (/[^\w\s./\\:'"-]/u.test(command)) return undefined;
  const directScript = /^(?:node(?:\.exe)?|python3?|py|ruby|bash|sh|pwsh|powershell(?:\.exe)?)\s+(?:"([^"]+)"|'([^']+)'|([^\s"']+))$/i.exec(command);
  const directTarget = directScript?.[1] ?? directScript?.[2] ?? directScript?.[3];
  if (directTarget && /\.(?:[cm]?js|py|rb|sh|ps1)$/i.test(directTarget)) return directTarget;
  if (/^(?:npm|pnpm|yarn|bun)(?:\s+run)?\s+(?:test|check|lint|build|test:[\w:-]+|check:[\w:-]+)$/i.test(command)) {
    return "package.json";
  }
  return undefined;
}

function transitivelyDependsOn(
  step: TaskPolicyPlanStep,
  dependencyId: string,
  byId: Map<string, TaskPolicyPlanStep>,
  visited = new Set<string>(),
): boolean {
  if (step.dependencies?.includes(dependencyId)) return true;
  if (!step.id || visited.has(step.id)) return false;
  visited.add(step.id);
  return (step.dependencies ?? []).some(id => {
    const dependency = byId.get(id);
    return Boolean(dependency && transitivelyDependsOn(dependency, dependencyId, byId, new Set(visited)));
  });
}

function allowsDelegatedValidationCommand(
  policy: TaskPolicy,
  step: TaskPolicyPlanStep,
  command: string,
  planSteps: readonly TaskPolicyPlanStep[],
): boolean {
  if (!policy.delegatedValidationCommands || step.kind !== "validation") return false;
  const targetLiteral = delegatedValidationTarget(command);
  const target = targetLiteral ? resolveTaskPolicyPath(policy.workspaceRoot, targetLiteral) : undefined;
  if (!target || !step.id) return false;
  const byId = new Map(planSteps.flatMap(candidate => candidate.id ? [[candidate.id, candidate] as const] : []));
  return planSteps.some(candidate => {
    if (!candidate.id || !candidate.requiredToolNames.some(name => READ_TOOL.test(name))) return false;
    const candidateTarget = targetFromArguments(policy.workspaceRoot, candidate.expectedArguments);
    return candidateTarget === target && transitivelyDependsOn(step, candidate.id, byId);
  });
}

export function isConfidentlyReadOnlyCommand(command: string): boolean {
  const trimmed = command.trim();
  if (!trimmed || /[\r\n;&|<>`(){}$]/u.test(trimmed) || /%[^%\s]+%/u.test(trimmed)) return false;
  if (/^find(?:\s|$)/i.test(trimmed)
    && /(?:^|\s)-(?:delete|exec|execdir|ok|okdir|fprint|fprintf|fls)(?:\s|$)/i.test(trimmed)) return false;
  if (/^git\s+(?:status|diff|log|show)(?:\s|$)/i.test(trimmed)
    && /(?:^|\s)--(?:ext-diff|textconv|output)(?:[=\s]|$)/i.test(trimmed)) return false;
  return /^(?:pwd(?:\s|$)|ls(?:\s|$)|find(?:\s|$)|git\s+(?:status|diff|log|show)(?:\s|$)|cat(?:\s|$)|head(?:\s|$)|tail(?:\s|$)|type(?:\s|$)|get-childitem(?:\s|$)|get-content(?:\s|$)|test\s+!?\s+-[efd]\s+)/i.test(trimmed);
}

function readOnlyCommandStaysInWorkspace(workspaceRoot: string | undefined, command: string): boolean {
  if (!workspaceRoot) return false;
  if (/(?:^|[\\/])\.\.(?:[\\/]|$)/u.test(command) || /(?:^|\s)~[\\/]/u.test(command)) return false;
  const absolutePaths = command.match(/(?:[a-z]:[\\/][^\s"']+|\\\\[^\s"']+|(?:^|\s)\/(?!\s)[^\s"']+)/giu) ?? [];
  return absolutePaths.every(value => resolveTaskPolicyPath(workspaceRoot, value.trim()) !== undefined);
}

function policyCatalogAllows(policy: TaskPolicy, tools: readonly string[] | readonly CanonicalTool[]): boolean {
  const current = catalog(tools);
  return current.every(tool => {
    const frozen = policy.tools.find(candidate => candidate.name.toLowerCase() === tool.name.toLowerCase());
    if (!frozen) return false;
    if (frozen.inputSchema === undefined || tool.inputSchema === undefined) return true;
    return isDeepStrictEqual(frozen.inputSchema, tool.inputSchema);
  });
}

function requiredToolMatches(requirement: TaskPolicyRequirement, toolName: string): boolean {
  if (requirement.requiredToolNames.length === 0) return true;
  return requirement.requiredToolNames.some(name => name.toLowerCase() === toolName.toLowerCase());
}

function mutationOperation(step: TaskPolicyPlanStep, toolName: string): TaskPolicyMutationOperation {
  if (/^edit$/i.test(toolName)) return "edit";
  if (/^(?:delete|remove)$/i.test(toolName)) return "delete";
  return "create";
}

function mutationValues(step: TaskPolicyPlanStep, operation: TaskPolicyMutationOperation): string[] {
  const keys = operation === "create" ? ["content"] : operation === "edit" ? ["old_string", "new_string"] : [];
  return keys.map(key => step.expectedArguments[key]).filter((value): value is string => typeof value === "string").map(normalize);
}

function mutationRequirementMatches(
  policy: TaskPolicy,
  requirement: TaskPolicyRequirement,
  step: TaskPolicyPlanStep,
  toolName: string,
): boolean {
  const operation = mutationOperation(step, toolName);
  const target = targetFromArguments(policy.workspaceRoot, step.expectedArguments);
  const values = mutationValues(step, operation);
  if (requirement.kind !== "file_mutation") return false;
  if (requirement.operation && requirement.operation !== operation) return false;
  if (!requiredToolMatches(requirement, toolName)) return false;
  const expectedTarget = normalizedPolicyTarget(policy.workspaceRoot, requirement.target);
  if (expectedTarget && expectedTarget !== target) return false;
  return requirement.expectedValues.every(value => values.includes(normalize(value)));
}

function matchingMutationRequirement(
  policy: TaskPolicy,
  step: TaskPolicyPlanStep,
  toolName: string,
): TaskPolicyRequirement | undefined {
  return policy.requirements.find(requirement => mutationRequirementMatches(policy, requirement, step, toolName));
}

function mutationsUseDistinctRequirements(
  policy: TaskPolicy,
  steps: readonly TaskPolicyPlanStep[],
): boolean {
  if (policy.mutationScope !== "exact") return true;
  const available = policy.requirements.filter(requirement => requirement.kind === "file_mutation");
  for (const step of steps) {
    if (step.kind !== "mutation" || step.requiredToolNames.length !== 1) continue;
    const toolName = step.requiredToolNames[0]!;
    const index = available.findIndex(requirement => mutationRequirementMatches(
      policy,
      requirement,
      step,
      toolName,
    ));
    if (index < 0) return false;
    available.splice(index, 1);
  }
  return true;
}

function authorizeMutation(
  policy: TaskPolicy,
  step: TaskPolicyPlanStep,
  toolName: string,
  discoveredMutationTargets: readonly string[],
): TaskPolicyDecision {
  if (policy.mutationScope === "denied") return { allowed: false, reason: "mutation_not_authorized" };
  const target = targetFromArguments(policy.workspaceRoot, step.expectedArguments);
  if (!target) return { allowed: false, reason: policy.workspaceRoot ? "unsafe_arguments" : "workspace_unknown" };
  if (policy.mutationScope === "workspace"
    && policy.mutationTargetsRequireDiscoveryEvidence
    && !policy.mutationTargets.includes(target)
    && !discoveredMutationTargets.includes(target)) {
    return { allowed: false, reason: "target_not_authorized" };
  }
  const requirement = matchingMutationRequirement(policy, step, toolName);
  if (!requirement) {
    if (policy.mutationScope === "workspace" && MUTATION_TOOL.test(toolName)) {
      return { allowed: true, reason: "allowed" };
    }
    const expectedTarget = policy.requirements.some(item => item.kind === "file_mutation"
      && normalizedPolicyTarget(policy.workspaceRoot, item.target) === target);
    return { allowed: false, reason: expectedTarget ? "value_not_authorized" : "target_not_authorized" };
  }
  return { allowed: true, reason: "allowed" };
}

function authorizeReadTarget(policy: TaskPolicy, step: TaskPolicyPlanStep): TaskPolicyDecision {
  const target = targetFromArguments(policy.workspaceRoot, step.expectedArguments);
  if (!target) return policy.readScope === "workspace"
    ? { allowed: true, reason: "allowed" }
    : { allowed: false, reason: policy.workspaceRoot ? "target_not_authorized" : "workspace_unknown" };
  if (policy.readScope === "workspace" || policy.readTargets.includes(target)) {
    return { allowed: true, reason: "allowed" };
  }
  return { allowed: false, reason: "target_not_authorized" };
}

function explicitlyAuthorizesShellTool(policy: TaskPolicy, toolName: string, command: string): boolean {
  return policy.explicitCommands.includes(command)
    || policy.requirements.some(requirement => (
      COMMAND_ACTION_KIND.test(requirement.kind)
      && requiredToolMatches(requirement, toolName)
    ));
}

function authorizeStep(
  policy: TaskPolicy,
  step: TaskPolicyPlanStep,
  planSteps: readonly TaskPolicyPlanStep[],
  discoveredMutationTargets: readonly string[],
): TaskPolicyDecision {
  if (step.requiredToolNames.length !== 1) return { allowed: false, reason: "ambiguous_tool" };
  const toolName = step.requiredToolNames[0]!;
  const policyTool = policy.tools.find(tool => tool.name.toLowerCase() === toolName.toLowerCase());
  if (!policyTool) return { allowed: false, reason: "tool_not_authorized" };
  if (!pathArgumentsStayInWorkspace(policy.workspaceRoot, step.expectedArguments)) {
    return { allowed: false, reason: policy.workspaceRoot ? "unsafe_arguments" : "workspace_unknown" };
  }

  if (SHELL_TOOL.test(toolName)) {
    const command = commandFromArguments(step.expectedArguments);
    if (!command) return { allowed: false, reason: "unsafe_command" };
    if (isConfidentlyReadOnlyCommand(command)) {
      if (!readOnlyCommandStaysInWorkspace(policy.workspaceRoot, command)) {
        return { allowed: false, reason: policy.workspaceRoot ? "unsafe_arguments" : "workspace_unknown" };
      }
      const exactRequirementsCoveredWithoutShell = policy.requirements.every(requirement => (
        requirementCovered(policy, requirement, planSteps.filter(candidate => candidate !== step))
      ));
      if (policy.readScope !== "workspace"
        && exactRequirementsCoveredWithoutShell
        && !explicitlyAuthorizesShellTool(policy, toolName, command)) {
        return { allowed: false, reason: "target_not_authorized" };
      }
      return { allowed: true, reason: "allowed" };
    }
    if (!policy.explicitCommands.includes(command)
      && !allowsDelegatedValidationCommand(policy, step, command, planSteps)) {
      return { allowed: false, reason: "unsafe_command" };
    }
    if (step.kind === "mutation") return authorizeMutation(policy, step, toolName, discoveredMutationTargets);
    return { allowed: true, reason: "allowed" };
  }

  if (MUTATION_TOOL.test(toolName) || step.kind === "mutation") {
    if (step.kind !== "mutation") return { allowed: false, reason: "mutation_not_authorized" };
    return authorizeMutation(policy, step, toolName, discoveredMutationTargets);
  }
  if (READ_TOOL.test(toolName)) return authorizeReadTarget(policy, step);
  if (!policy.explicitToolNames.some(name => name.toLowerCase() === toolName.toLowerCase())) {
    return { allowed: false, reason: "tool_not_authorized" };
  }
  return { allowed: true, reason: "allowed" };
}

function requirementCovered(policy: TaskPolicy, requirement: TaskPolicyRequirement, steps: TaskPolicyPlanStep[]): boolean {
  if (requirement.kind === "file_mutation") {
    return steps.some(step => step.kind === "mutation"
      && step.requiredToolNames.length === 1
      && matchingMutationRequirement(policy, step, step.requiredToolNames[0]!) === requirement);
  }
  if (requirement.kind === "file_verification") {
    const expectedTarget = normalizedPolicyTarget(policy.workspaceRoot, requirement.target);
    return steps.some(step => {
      if (step.kind !== "discovery" && step.kind !== "verification" && step.kind !== "validation") return false;
      const toolName = step.requiredToolNames[0];
      if (!toolName || !requiredToolMatches(requirement, toolName)) return false;
      const actualTarget = targetFromArguments(policy.workspaceRoot, step.expectedArguments);
      return expectedTarget ? actualTarget === expectedTarget : true;
    });
  }
  if (requirement.kind === "environment_inspection") {
    return steps.some(step => step.requiredToolNames.length === 1
      && (READ_TOOL.test(step.requiredToolNames[0]!)
        || (SHELL_TOOL.test(step.requiredToolNames[0]!)
          && isConfidentlyReadOnlyCommand(commandFromArguments(step.expectedArguments) ?? ""))));
  }
  return steps.some(step => step.requiredToolNames.length === 1
    && requiredToolMatches(requirement, step.requiredToolNames[0]!)
    && (requirement.expectedValues.length === 0
      || requirement.expectedValues.every(value => Object.values(step.expectedArguments)
        .some(actual => typeof actual === "string" && normalize(actual) === normalize(value)))));
}

export function authorizeExecutionPlan(
  policy: TaskPolicy,
  steps: readonly TaskPolicyPlanStep[],
  tools: readonly string[] | readonly CanonicalTool[],
  requireOriginalActions: boolean,
  allowDeferredOriginalActions = false,
  discoveredMutationTargets: readonly string[] = [],
  allowUncoveredDeferredOriginalActions = false,
): TaskPolicyDecision {
  if (!policyCatalogAllows(policy, tools)) return { allowed: false, reason: "tool_catalog_changed" };
  for (const step of steps) {
    const decision = authorizeStep(policy, step, steps, discoveredMutationTargets);
    if (!decision.allowed) return decision;
  }
  if (!mutationsUseDistinctRequirements(policy, steps)) {
    return { allowed: false, reason: "mutation_not_authorized" };
  }
  if (requireOriginalActions) {
    const missingOriginalAction = policy.requirements.some(
      requirement => !requirementCovered(policy, requirement, [...steps]),
    );
    const coversOriginalAction = policy.requirements.some(
      requirement => requirementCovered(policy, requirement, [...steps]),
    );
    if (missingOriginalAction && !(allowDeferredOriginalActions
      && (coversOriginalAction || allowUncoveredDeferredOriginalActions))) {
      return { allowed: false, reason: "required_action_missing" };
    }
  }
  return { allowed: true, reason: "allowed" };
}

function isTaskPolicyTool(value: unknown): value is TaskPolicyTool {
  return isRecord(value)
    && typeof value.name === "string"
    && (value.inputSchema === undefined || isRecord(value.inputSchema));
}

function isTaskPolicyRequirement(value: unknown): value is TaskPolicyRequirement {
  return isRecord(value)
    && typeof value.kind === "string"
    && (value.operation === undefined || typeof value.operation === "string")
    && (value.target === undefined || typeof value.target === "string")
    && Array.isArray(value.expectedValues)
    && value.expectedValues.every(item => typeof item === "string")
    && Array.isArray(value.requiredToolNames)
    && value.requiredToolNames.every(item => typeof item === "string");
}

export function normalizeTaskPolicy(value: unknown): TaskPolicy | undefined {
  if (!isRecord(value)
    || value.version !== 1
    || (value.workspaceRoot !== undefined && typeof value.workspaceRoot !== "string")
    || !Array.isArray(value.tools)
    || !value.tools.every(isTaskPolicyTool)
    || !Array.isArray(value.requirements)
    || !value.requirements.every(isTaskPolicyRequirement)
    || !["denied", "exact", "workspace"].includes(String(value.mutationScope))
    || !Array.isArray(value.mutationTargets)
    || !value.mutationTargets.every(item => typeof item === "string")
    || !["exact", "workspace"].includes(String(value.readScope))
    || !Array.isArray(value.readTargets)
    || !value.readTargets.every(item => typeof item === "string")
    || !Array.isArray(value.explicitToolNames)
    || !value.explicitToolNames.every(item => typeof item === "string")
    || !Array.isArray(value.explicitCommands)
    || !value.explicitCommands.every(item => typeof item === "string")
    || (value.delegatedValidationCommands !== undefined && typeof value.delegatedValidationCommands !== "boolean")
    || (value.mutationTargetsRequireDiscoveryEvidence !== undefined
      && typeof value.mutationTargetsRequireDiscoveryEvidence !== "boolean")
    || typeof value.createdAt !== "number"
    || !Number.isFinite(value.createdAt)) return undefined;
  return {
    ...(structuredClone(value) as unknown as TaskPolicy),
    delegatedValidationCommands: value.delegatedValidationCommands === true,
    mutationTargetsRequireDiscoveryEvidence: value.mutationTargetsRequireDiscoveryEvidence === true
      || (value.mutationTargetsRequireDiscoveryEvidence === undefined && value.mutationScope === "workspace"),
  };
}
