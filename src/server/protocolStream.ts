import type { CanonicalChunk, CanonicalResult, CanonicalToolCall } from "../api/canonical.js";
import type { Protocol } from "../api/normalizeByProtocol.js";
import {
  anthropicSseError,
  anthropicSseMessageDone,
  anthropicSseMessageStart,
  anthropicSseStop,
  type AnthropicPublicError,
} from "./outputAnthropic.js";
import { openaiSseChunk, openaiSseDone } from "./outputOpenAI.js";
import { responsesSseDone, responsesSseOutputText } from "./outputResponses.js";

export class ProtocolStream {
  private readonly model: string;
  private blockIndex = 0;
  private hadToolUse = false;
  private started = false;
  private textBlockOpen = false;
  private terminal: "open" | "success" | "error" = "open";

  constructor(
    private readonly protocol: Protocol,
    model: string,
    private readonly write: (data: string) => void,
  ) {
    this.model = model;
  }

  start(): void {
    if (this.started || this.terminal !== "open") return;
    this.started = true;
    if (this.protocol === "anthropic") {
      this.write(anthropicSseMessageStart(this.model, 0));
    }
  }

  private closeTextBlock(): void {
    if (!this.textBlockOpen) return;
    this.write(`event: content_block_stop\ndata: ${JSON.stringify({
      type: "content_block_stop",
      index: this.blockIndex,
    })}\n\n`);
    this.blockIndex++;
    this.textBlockOpen = false;
  }

  push(chunk: CanonicalChunk): void {
    if (this.terminal !== "open") return;
    if (chunk.type === "content") {
      if (!chunk.text) return;
      if (this.protocol === "openai") {
        this.write(openaiSseChunk(0, chunk.text));
      }
      if (this.protocol === "anthropic") {
        if (!this.textBlockOpen) {
          this.write(`event: content_block_start\ndata: ${JSON.stringify({
            type: "content_block_start",
            index: this.blockIndex,
            content_block: { type: "text", text: "" },
          })}\n\n`);
          this.textBlockOpen = true;
        }
        this.write(`event: content_block_delta\ndata: ${JSON.stringify({
          type: "content_block_delta",
          index: this.blockIndex,
          delta: { type: "text_delta", text: chunk.text },
        })}\n\n`);
      }
      if (this.protocol === "responses") {
        this.write(responsesSseOutputText(chunk.text));
      }
      return;
    }
    if (chunk.type === "thinking") {
      if (this.protocol === "anthropic" && chunk.text) {
        this.closeTextBlock();
        const idx = this.blockIndex++;
        this.write(`event: content_block_start\ndata: ${JSON.stringify({
          type: "content_block_start",
          index: idx,
          content_block: { type: "thinking", thinking: "" },
        })}\n\n`);
        this.write(`event: content_block_delta\ndata: ${JSON.stringify({
          type: "content_block_delta",
          index: idx,
          delta: { type: "thinking_delta", thinking: chunk.text },
        })}\n\n`);
        this.write(`event: content_block_stop\ndata: ${JSON.stringify({
          type: "content_block_stop",
          index: idx,
        })}\n\n`);
      }
      return;
    }
    if (chunk.type === "tool_use") {
      const call = chunk.toolCall as CanonicalToolCall | undefined;
      if (!call) return;
      this.closeTextBlock();
      this.hadToolUse = true;
      if (this.protocol === "openai") {
        this.write(openaiSseChunk(0, JSON.stringify({
          tool_calls: [{
            id: call.id,
            type: "function",
            function: { name: call.name, arguments: JSON.stringify(call.arguments) },
          }],
        })));
      }
      if (this.protocol === "anthropic") {
        const idx = this.blockIndex++;
        this.write(`event: content_block_start\ndata: ${JSON.stringify({
          type: "content_block_start",
          index: idx,
          content_block: { type: "tool_use", id: call.id, name: call.name, input: {} },
        })}\n\n`);
        this.write(`event: content_block_delta\ndata: ${JSON.stringify({
          type: "content_block_delta",
          index: idx,
          delta: { type: "input_json_delta", partial_json: JSON.stringify(call.arguments) },
        })}\n\n`);
        this.write(`event: content_block_stop\ndata: ${JSON.stringify({
          type: "content_block_stop",
          index: idx,
        })}\n\n`);
      }
    }
  }

  finish(usage?: CanonicalResult["usage"]): void {
    if (this.terminal !== "open") return;
    this.terminal = "success";
    if (this.protocol === "anthropic") {
      this.closeTextBlock();
    }
    if (this.protocol === "openai") this.write(openaiSseDone(0));
    if (this.protocol === "anthropic") {
      this.write(anthropicSseMessageDone(this.hadToolUse ? "tool_use" : "end_turn", usage));
      this.write(anthropicSseStop());
    }
    if (this.protocol === "responses") this.write(responsesSseDone());
  }

  fail(error: AnthropicPublicError): boolean {
    if (this.protocol !== "anthropic" || !this.started || this.terminal !== "open") return false;
    this.terminal = "error";
    this.write(anthropicSseError(error));
    return true;
  }
}
