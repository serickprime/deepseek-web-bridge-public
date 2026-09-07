const AVERAGE_TOKENS_PER_CHAR_CJK = 1 / 1.5;
const AVERAGE_TOKENS_PER_CHAR_LATIN = 1 / 4.2;

export function hasCjk(text: string): boolean {
  return /[\u3040-\u30ff\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff]/.test(text);
}

export function countCjkChars(text: string): number {
  const matches = text.match(/[\u3040-\u30ff\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff]/g);
  return matches ? matches.length : 0;
}

export function estimateTokenCount(text: string): number {
  if (!text) return 0;
  const cjk = countCjkChars(text);
  const other = text.length - cjk;
  const estimated = cjk * AVERAGE_TOKENS_PER_CHAR_CJK + other * AVERAGE_TOKENS_PER_CHAR_LATIN;
  return Math.max(1, Math.ceil(estimated));
}

export function estimateChatTokenCount(messages: Array<{ role?: string; content?: unknown }>): number {
  if (!Array.isArray(messages) || messages.length === 0) return 0;
  let total = 0;
  for (const message of messages) {
    const content = message.content;
    if (typeof content === "string") {
      total += estimateTokenCount(content);
    } else if (Array.isArray(content)) {
      for (const part of content) {
        if (part && typeof part === "object" && "text" in part && typeof (part as { text: string }).text === "string") {
          total += estimateTokenCount((part as { text: string }).text);
        }
      }
    }
    total += 4;
  }
  return total;
}
