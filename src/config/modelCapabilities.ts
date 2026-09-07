import { BridgeError } from "../utils/errors.js";

export const DEFAULT_MODEL_ID = "deepseek-v4-flash";
export const OPENCODE_PROVIDER_ID = "deepseek-bridge";

export type UpstreamModelType = "default" | "expert";

export interface ModelCapability {
  id: string;
  displayName: string;
  upstreamModelType: UpstreamModelType;
  reasoning: boolean;
  search: boolean;
}

export interface ModelSelection {
  requestedId: string;
  canonicalId: string;
  upstreamModelType: UpstreamModelType;
  thinkingEnabled: boolean;
  searchEnabled: boolean;
  legacyAlias: boolean;
}

export const PRIMARY_MODELS: readonly ModelCapability[] = [
  {
    id: "deepseek-v4-flash",
    displayName: "DeepSeek V4 Flash (Instant)",
    upstreamModelType: "default",
    reasoning: true,
    search: true,
  },
  {
    id: "deepseek-v4-pro",
    displayName: "DeepSeek V4 Pro (Expert)",
    upstreamModelType: "expert",
    reasoning: true,
    search: false,
  },
] as const;

interface ModelAlias {
  canonicalId: string;
  defaultThinking: boolean;
}

export const LEGACY_MODEL_ALIASES: Readonly<Record<string, ModelAlias>> = {
  "deepseek-chat": { canonicalId: "deepseek-v4-flash", defaultThinking: false },
  "deepseek-reasoner": { canonicalId: "deepseek-v4-flash", defaultThinking: true },
};

const PRIMARY_BY_ID = new Map(PRIMARY_MODELS.map(model => [model.id, model]));

export function resolveModelSelection(
  requestedId: string,
  reasoning?: boolean,
  search = false,
): ModelSelection {
  const normalizedId = requestedId.trim();
  const alias = LEGACY_MODEL_ALIASES[normalizedId];
  const canonicalId = alias?.canonicalId ?? normalizedId;
  const capability = PRIMARY_BY_ID.get(canonicalId);
  if (!capability) {
    throw new BridgeError(
      `Unknown model: ${requestedId}. Available models: ${PRIMARY_MODELS.map(model => model.id).join(", ")}.`,
      { code: "MODEL_UNAVAILABLE", status: 400 },
    );
  }
  if (search && !capability.search) {
    throw new BridgeError(
      `Search is not available for ${capability.id} in the current DeepSeek Web UI.`,
      { code: "MODEL_UNAVAILABLE", status: 400 },
    );
  }
  return {
    requestedId: normalizedId,
    canonicalId: capability.id,
    upstreamModelType: capability.upstreamModelType,
    thinkingEnabled: reasoning ?? alias?.defaultThinking ?? false,
    searchEnabled: search,
    legacyAlias: Boolean(alias),
  };
}

export function openCodeModelId(modelId: string): string {
  const selection = resolveModelSelection(modelId);
  return `${OPENCODE_PROVIDER_ID}/${selection.canonicalId}`;
}

export function bridgeModelList(): Array<{ id: string; object: "model"; owned_by: "deepseek" }> {
  return PRIMARY_MODELS.map(model => ({ id: model.id, object: "model", owned_by: "deepseek" }));
}
