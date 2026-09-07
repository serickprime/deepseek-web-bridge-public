import fs from "node:fs/promises";
import path from "node:path";
import { BridgeError } from "../utils/errors.js";
import { DEFAULT_POW_WASM_URL } from "../config/constants.js";
import type { Logger } from "../utils/logger.js";

export interface PowChallenge {
  signature: string;
  targetPath: string;
  algorithm: string;
  salt: string;
  challenge: string;
  saltNumber: number;
  complexity: number;
  difficulty: number;
  expireAt: number;
}

export interface PowSolution {
  answer: number;
  algorithm: string;
  signature: string;
  salt: string;
  challenge: string;
  targetPath: string;
}

export interface PowSolverOptions {
  wasmUrl?: string;
  wasmCacheDir?: string;
  logger?: Logger;
}

export class PowSolver {
  private readonly wasmUrl: string;
  private readonly wasmCacheDir: string;
  private readonly logger?: Logger;
  private wasmBytes: Uint8Array | null = null;

  constructor(options: PowSolverOptions = {}) {
    this.wasmUrl = options.wasmUrl ?? DEFAULT_POW_WASM_URL;
    this.wasmCacheDir = options.wasmCacheDir ?? "";
    this.logger = options.logger;
  }

  async ensureWasm(): Promise<Uint8Array> {
    if (this.wasmBytes) return this.wasmBytes;
    if (this.wasmCacheDir) {
      const cached = path.join(this.wasmCacheDir, "sha3_wasm.wasm");
      try {
        const data = await fs.readFile(cached);
        this.wasmBytes = new Uint8Array(data);
        return this.wasmBytes;
      } catch {
        // fall through to download
      }
    }
    const res = await fetch(this.wasmUrl);
    if (!res.ok) {
      throw new BridgeError(`Failed to download PoW WASM (${res.status}).`, {
        code: "WASM_DOWNLOAD_FAILED",
        retryable: true,
      });
    }
    const buf = await res.arrayBuffer();
    this.wasmBytes = new Uint8Array(buf);
    if (this.wasmCacheDir) {
      try {
        await fs.mkdir(this.wasmCacheDir, { recursive: true });
        await fs.writeFile(path.join(this.wasmCacheDir, "sha3_wasm.wasm"), this.wasmBytes);
      } catch {
        // caching is best-effort
      }
    }
    return this.wasmBytes;
  }

  async solve(challenge: PowChallenge, logger = this.logger): Promise<PowSolution> {
    const startedAt = Date.now();
    logger?.info("pow_solve_start", { stage: "pow_solve", outcome: "start" });
    try {
      const wasm = await this.ensureWasm();
      let answer: number;
      if (challenge.difficulty > 0) {
        answer = await this.runWasmSolve(wasm, challenge);
      } else if (challenge.complexity > 0) {
        throw new BridgeError("Legacy complexity challenges are no longer supported.", { code: "POW_CHALLENGE_FAILED" });
      } else {
        throw new BridgeError("No solvable challenge format.", { code: "POW_CHALLENGE_FAILED" });
      }
      logger?.info("pow_solved", {
        stage: "pow_solve",
        outcome: "success",
        latency_ms: Date.now() - startedAt,
      });
      return {
        answer,
        algorithm: challenge.algorithm,
        signature: challenge.signature,
        salt: challenge.salt,
        challenge: challenge.challenge,
        targetPath: challenge.targetPath,
      };
    } catch (error) {
      const bridgeError = error instanceof BridgeError ? error : undefined;
      logger?.warn("pow_solve_failed", {
        stage: "pow_solve",
        outcome: "failure",
        latency_ms: Date.now() - startedAt,
        failure_class: bridgeError?.code ?? "UNHANDLED_ERROR",
        cause_code: bridgeError?.causeCode ?? "solver_error",
        retryable: bridgeError?.retryable ?? false,
      });
      throw error;
    }
  }

  private async runWasmSolve(
    wasmBytes: Uint8Array,
    challenge: PowChallenge,
  ): Promise<number> {
    const wasmGlobal = globalThis as unknown as {
      WebAssembly: {
        instantiate(bytes: Uint8Array, imports: object): Promise<{
          instance: {
            exports: {
              memory?: { buffer: ArrayBuffer };
              wasm_solve?: (stackPtr: number, chalPtr: number, chalLen: number, prefPtr: number, prefLen: number, difficulty: number) => void;
              wasm_deepseek_hash_v1?: (ptr: number, len: number, out: number) => void;
              __wbindgen_add_to_stack_pointer?: (delta: number) => number;
              __wbindgen_export_0?: (size: number, align: number) => number;
              __wbindgen_export_1?: (ptr: number, oldSize: number, newSize: number, align: number) => number;
            };
          };
        }>;
      };
    };

    if (challenge.difficulty > 0 && challenge.challenge && challenge.expireAt > 0) {
      const module = await wasmGlobal.WebAssembly.instantiate(wasmBytes, {});
      const exp = module.instance.exports;
      if (!exp.wasm_solve || !exp.__wbindgen_add_to_stack_pointer || !exp.__wbindgen_export_0 || !exp.__wbindgen_export_1) {
        throw new BridgeError("PoW WASM missing required exports.", { code: "WASM_COMPILE_FAILED" });
      }

      const memory = exp.memory;
      if (!memory) throw new BridgeError("PoW WASM missing memory.", { code: "WASM_COMPILE_FAILED" });

      const stackPtr = exp.__wbindgen_add_to_stack_pointer(-16);
      try {
        const encoder = new TextEncoder();

        const challengeBytes = encoder.encode(challenge.challenge);
        const challengePtr = exp.__wbindgen_export_0(challengeBytes.length, 1);
        new Uint8Array(memory.buffer, challengePtr, challengeBytes.length).set(challengeBytes);

        const prefix = `${challenge.salt}_${challenge.expireAt}_`;
        const prefixBytes = encoder.encode(prefix);
        const prefixPtr = exp.__wbindgen_export_0(prefixBytes.length, 1);
        new Uint8Array(memory.buffer, prefixPtr, prefixBytes.length).set(prefixBytes);

        exp.wasm_solve(stackPtr, challengePtr, challengeBytes.length, prefixPtr, prefixBytes.length, challenge.difficulty);

        const view = new DataView(memory.buffer);
        const errCode = view.getInt32(stackPtr + 0, true);
        const answerFloat = view.getFloat64(stackPtr + 8, true);

        if (errCode === 0 || typeof answerFloat !== "number" || isNaN(answerFloat)) {
          throw new BridgeError("PoW WASM returned no solution.", { code: "POW_CHALLENGE_FAILED" });
        }

        return answerFloat;
      } finally {
        exp.__wbindgen_add_to_stack_pointer(16);
      }
    }

    throw new BridgeError("PoW WASM returned no solution.", { code: "POW_CHALLENGE_FAILED" });
  }
}

export function parseChallengePayload(body: unknown): PowChallenge | null {
  if (!body || typeof body !== "object") return null;
  const record = body as Record<string, unknown>;

  // New format: { data: { biz_data: { challenge: { ... } } } }
  let d: Record<string, unknown> | null = null;
  const data = record.data;
  if (data && typeof data === "object") {
    const dataRecord = data as Record<string, unknown>;
    const bizData = dataRecord.biz_data;
    if (bizData && typeof bizData === "object") {
      const challenge = (bizData as Record<string, unknown>).challenge;
      if (challenge && typeof challenge === "object") {
        d = challenge as Record<string, unknown>;
      }
    }
    // Old format fallback: data has fields directly
    if (!d && typeof dataRecord.signature === "string") {
      d = dataRecord;
    }
  }

  if (!d) return null;

  const signature = typeof d.signature === "string" ? d.signature : "";
  const targetPath = typeof d.target_path === "string" ? d.target_path : "";
  const algorithm = typeof d.algorithm === "string" ? d.algorithm : "";
  const salt = typeof d.salt === "string" ? d.salt : "";
  const saltNumber = typeof d.salt_number === "number" ? d.salt_number : 0;
  const complexity = typeof d.complexity === "number" ? d.complexity : 0;
  const difficulty = typeof d.difficulty === "number" ? d.difficulty : 0;
  const expireAt = typeof d.expire_at === "number" ? d.expire_at : 0;
  const challenge = typeof d.challenge === "string" ? d.challenge : "";

  if (!signature || !salt) return null;
  if (complexity <= 0 && difficulty <= 0) return null;

  return { signature, targetPath, algorithm, salt, challenge, saltNumber, complexity, difficulty, expireAt };
}
