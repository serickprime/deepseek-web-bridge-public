import { isDeepStrictEqual } from "node:util";
import type { CanonicalTool } from "../api/canonical.js";
import { BridgeError } from "../utils/errors.js";

const UNAVAILABLE_BRIDGE_TOOLS = new Set(["artifact"]);
export const TOOL_CATALOG_MAX_BYTES = 128 * 1024;

export interface BridgeToolSelection {
  available: CanonicalTool[];
  unavailableNames: string[];
}

export interface BuiltToolCatalog extends BridgeToolSelection {
  text: string;
  utf8Bytes: number;
}

export function selectBridgeTools(tools: CanonicalTool[]): BridgeToolSelection {
  const available: CanonicalTool[] = [];
  const unavailableNames: string[] = [];
  for (const tool of tools) {
    if (UNAVAILABLE_BRIDGE_TOOLS.has(tool.name.toLowerCase())) {
      unavailableNames.push(tool.name);
    } else {
      available.push(tool);
    }
  }
  return { available, unavailableNames };
}

function serializeInputSchema(inputSchema: Record<string, unknown>): string {
  let serialized: string | undefined;
  try {
    serialized = JSON.stringify(inputSchema);
  } catch {
    throw new BridgeError("Tool input schema must be valid JSON.", {
      code: "INVALID_REQUEST",
      status: 400,
    });
  }
  if (serialized === undefined || !isDeepStrictEqual(JSON.parse(serialized), inputSchema)) {
    throw new BridgeError("Tool input schema must round-trip as valid JSON without data loss.", {
      code: "INVALID_REQUEST",
      status: 400,
    });
  }
  return serialized;
}

export function buildToolCatalog(tools: CanonicalTool[]): BuiltToolCatalog {
  const { available, unavailableNames } = selectBridgeTools(tools);
  if (available.length === 0) return { available, unavailableNames, text: "", utf8Bytes: 0 };

  const safe = available.map(t => ({
    name: t.name,
    description: (t.description ?? "").slice(0, 1000),
    inputSchema: serializeInputSchema(t.inputSchema),
  }));

  const toolList = safe.map(t => {
    const desc = t.description || "No description";
    return `- ${t.name}\n  Purpose: ${desc}\n  Input schema: ${t.inputSchema}`;
  }).join("\n");
  const text = `Available tools:\n${toolList}`;
  const utf8Bytes = Buffer.byteLength(text, "utf8");
  if (utf8Bytes > TOOL_CATALOG_MAX_BYTES) {
    throw new BridgeError(
      `Tool catalog is ${utf8Bytes} UTF-8 bytes and exceeds the ${TOOL_CATALOG_MAX_BYTES}-byte limit.`,
      { code: "REQUEST_TOO_LARGE", status: 413 },
    );
  }
  return { available, unavailableNames, text, utf8Bytes };
}

export function buildToolPromptFromCatalog(catalog: string): string {
  if (!catalog) return "";

  return [
    "",
    "--- TOOL REQUEST SYSTEM ---",
    catalog,
    "",
    "## RULES (mandatory, no exceptions)",
    "",
    "1. If the user asked to perform an action and a suitable tool exists:",
    "   - Do NOT ask for confirmation.",
    "   - Do NOT explain what you are going to do.",
    "   - Do NOT show the command as plain text.",
    "   - IMMEDIATELY return a tool_call JSON.",
    "",
    "2. If the task requires reading files, listing directories, creating or",
    "   editing files, running commands, or any action in the external",
    "   environment — a text response instead of a tool_call is FORBIDDEN.",
    "",
    "3. NEVER write phrases like:",
    "   \"I will execute...\", \"Let me run...\", \"Use the command...\",",
    "   \"ls ...\", \"cat ...\", \"mkdir ...\", or show any shell command",
    "   as text, if that operation can be performed by an available tool.",
    "",
    "4. After receiving a tool_result: automatically continue.",
    "   - If another tool call is needed — call it immediately.",
    "   - If the work is done — give the final answer.",
    "   - Do NOT wait for a new user message.",
    "",
    "5. If the user says \"do it\", \"execute\", \"yes\", \"continue\",",
    "   \"go ahead\", \"sure\", or similar after describing an action —",
    "   execute via tool immediately. Do not repeat the description.",
    "",
    "6. Decide: does the task require one of the available tools?",
    "   - If NO tool is needed: return the normal final answer as plain text.",
    "     Do not invent tool calls when the question can be answered directly.",
    "   - If a tool IS required: return exactly one JSON object and nothing else:",
    "     {\"tool_call\":{\"name\":\"tool_name\",\"arguments\":{}}}",
    "     No Markdown. No explanations. No text before or after the JSON.",
    "",
    "7. Use only the tool names listed above.",
    "   Prefer the most specific available tool for the task.",
    "   Do not use a general shell/command tool when a dedicated tool can do it.",
    "   Do not simulate or describe the tool result — wait for the real result.",
    "",
    "8. PATH RULES (mandatory):",
    "   a) The current working directory (cwd) provided in the system prompt",
    "      is the ONLY source of truth for file locations.",
    "   b) NEVER invent absolute paths like C:\\Users\\..., /home/...,",
    "      /c/Users/..., D:\\..., or any other path not explicitly given",
    "      by the user or derived from cwd.",
    "   c) If a file tool requires an absolute path (e.g. file_path),",
    "      resolve it relative to the cwd from the system prompt.",
    "   d) If the user gives a relative path — resolve it from cwd.",
    "   e) If you do not know the cwd or it seems wrong/missing —",
    "      first run a Bash tool to confirm the real cwd before proceeding.",
    "   f) Explicitly user-provided absolute paths (e.g. \"read C:\\foo\\bar\")",
    "      may be used as given. Do not rewrite them.",
    "",
    "9. COMPLETION GUARD (mandatory):",
    "   A) A final answer is allowed ONLY when ALL actions requested by the",
    "      user have actually been executed via tool calls.",
    "   B) Each file operation or command must be confirmed by a real",
    "      tool_result. Do NOT count an action as done because it was",
    "      mentioned in text, reasoning, history, or compact summary.",
    "      Text such as `pwd`, `ls -la`, `Output:`, `Вывод:` or a plausible",
    "      shell listing is NOT a tool_result. Only a tool_result supplied",
    "      by the client in the CURRENT tool cycle counts as evidence.",
    "   C) After every tool_result, check: are there remaining unfulfilled",
    "      actions from the user request?",
    "      - If YES: immediately call the next tool.",
    "      - If NO: give the final answer.",
    "   D) NEVER write \"created\", \"read\", \"verified\", \"done\", \"written\"",
    "      or similar claims unless the corresponding tool_result exists",
    "      in this turn's conversation.",
    "      A failed tool_result (is_error=true) is evidence of failure,",
    "      never evidence that the requested action was completed.",
    "   E) Compact summaries are context only — they do NOT prove that any",
    "      specific tool was executed. Verify with a real tool_result or",
    "      explicitly state what was and was not done.",
    "",
    "10. FINAL ANSWER RULES (mandatory):",
    "   A) Before giving a final answer, mentally enumerate every concrete",
    "      action the user asked for.",
    "   B) For each action, confirm that a tool_result with a success",
    "      indicator exists in the current exchange.",
    "   C) If any action is missing its tool_result — call the tool first.",
    "   D) If a tool_result shows an error — report the error honestly.",
    "      Do NOT claim success for a failed action.",
    "   E) When in doubt, perform an extra verification tool call rather",
    "      than claiming completion without proof.",
    "",
    "11. PRIORITY RULE (mandatory):",
    "   The CURRENT user request is authoritative.",
    "   Historical conversation, compact summaries, Historical Tool Actions",
    "   and previous tool calls are context only.",
    "   NEVER repeat a previous external action unless the current user",
    "   request explicitly requires it or it is required to continue",
    "   the current tool_result cycle.",
    "--- END TOOL REQUEST SYSTEM ---",
  ].join("\n");
}

export function buildToolPrompt(tools: CanonicalTool[]): string {
  return buildToolPromptFromCatalog(buildToolCatalog(tools).text);
}

export function buildToolNames(tools: CanonicalTool[]): Set<string> {
  return new Set(selectBridgeTools(tools).available.map(tool => tool.name));
}
