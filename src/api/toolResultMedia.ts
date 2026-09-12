import { getDocument } from "pdfjs-dist/legacy/build/pdf.mjs";
import ExcelJS from "exceljs";
import { realpath, readFile, stat } from "node:fs/promises";
import path from "node:path";
import type { CanonicalMessage, CanonicalToolCall } from "./canonical.js";

const MAX_DOCUMENT_BYTES = 20 * 1024 * 1024;
const MAX_EXTRACTED_TEXT_CHARS = 256_000;
const UNSUPPORTED_BINARY_RESULT = /(?:binary|cannot\s+read|not\s+supported|unsupported)[^\r\n]{0,160}(?:xlsx|spreadsheet|workbook|file)|(?:xlsx|spreadsheet|workbook)[^\r\n]{0,160}(?:binary|cannot\s+read|not\s+supported|unsupported)/iu;
const INDEPENDENT_FILE_FAILURE = /\b(?:EACCES|EPERM|ENOENT|permission\s+denied|access\s+(?:is\s+)?denied|operation\s+not\s+permitted|no\s+such\s+file(?:\s+or\s+directory)?|cannot\s+find(?:\s+the)?(?:\s+(?:file|path))?|does\s+not\s+exist|unauthori[sz]ed|forbidden|not\s+found|outside\s+(?:the\s+)?workspace|leaves?\s+(?:the\s+)?workspace)\b/iu;

export interface ToolResultMediaContext {
  workspaceRoot?: string;
  toolCalls: readonly CanonicalToolCall[];
}

function appendContent(current: string, addition: string): string {
  return [current.trim(), addition.trim()].filter(Boolean).join("\n\n");
}

function decodeBase64(data: string): Uint8Array {
  const normalized = data.replace(/\s+/g, "");
  if (normalized.length === 0
    || normalized.length % 4 !== 0
    || !/^[A-Za-z0-9+/]*={0,2}$/.test(normalized)) {
    throw new Error("invalid base64 document data");
  }
  const buffer = Buffer.from(normalized, "base64");
  if (buffer.length === 0 || buffer.length > MAX_DOCUMENT_BYTES) {
    throw new Error("document exceeds the supported media size");
  }
  return new Uint8Array(buffer);
}

async function extractPdfText(data: string): Promise<string> {
  const loadingTask = getDocument({
    data: decodeBase64(data),
    verbosity: 0,
  });
  const document = await loadingTask.promise;
  const pages: string[] = [];
  let totalLength = 0;
  try {
    for (let pageNumber = 1; pageNumber <= document.numPages; pageNumber++) {
      const page = await document.getPage(pageNumber);
      const textContent = await page.getTextContent();
      const text = textContent.items
        .map(item => "str" in item && typeof item.str === "string" ? item.str : "")
        .filter(Boolean)
        .join(" ")
        .replace(/\s+/g, " ")
        .trim();
      const section = `[PDF page ${pageNumber}]\n${text}`;
      totalLength += section.length;
      if (totalLength > MAX_EXTRACTED_TEXT_CHARS) {
        throw new Error("extracted PDF text exceeds the supported prompt size");
      }
      pages.push(section);
    }
  } finally {
    await document.destroy();
  }
  const extracted = pages.join("\n\n").trim();
  if (!extracted || !pages.some(page => /\n\S/.test(page))) {
    throw new Error("PDF contains no extractable text");
  }
  return `[Bridge-extracted PDF text]\n${extracted}\n[End Bridge-extracted PDF text]`;
}

function pathApi(value: string): typeof path.posix {
  return /^[a-z]:[\\/]/i.test(value) || /^\\\\/.test(value) ? path.win32 : path.posix;
}

function pathWithin(root: string, candidate: string): boolean {
  const api = pathApi(root);
  const relative = api.relative(root, candidate);
  return relative !== ".." && !relative.startsWith(`..${api.sep}`) && !api.isAbsolute(relative);
}

async function resolveReadableWorkspaceFile(
  workspaceRoot: string,
  requestedPath: string,
): Promise<string> {
  const api = pathApi(workspaceRoot);
  const lexicalRoot = api.resolve(workspaceRoot);
  const lexicalTarget = api.resolve(lexicalRoot, requestedPath.normalize("NFC").trim());
  if (!pathWithin(lexicalRoot, lexicalTarget)) throw new Error("spreadsheet path leaves the workspace");
  const [resolvedRoot, resolvedTarget] = await Promise.all([realpath(lexicalRoot), realpath(lexicalTarget)]);
  if (!pathWithin(resolvedRoot, resolvedTarget)) throw new Error("spreadsheet path leaves the workspace");
  const metadata = await stat(resolvedTarget);
  if (!metadata.isFile() || metadata.size === 0 || metadata.size > MAX_DOCUMENT_BYTES) {
    throw new Error("spreadsheet exceeds the supported media size");
  }
  return resolvedTarget;
}

async function extractXlsxText(workspaceRoot: string, requestedPath: string): Promise<string> {
  const resolved = await resolveReadableWorkspaceFile(workspaceRoot, requestedPath);
  const workbook = new ExcelJS.Workbook();
  const bytes = await readFile(resolved);
  await workbook.xlsx.load(Uint8Array.from(bytes).buffer);
  const sheets: string[] = [];
  let totalLength = 0;
  workbook.eachSheet(worksheet => {
    const rows: string[] = [];
    worksheet.eachRow({ includeEmpty: false }, (row, rowNumber) => {
      const cells: string[] = [];
      for (let column = 1; column <= row.cellCount; column++) {
        cells.push(row.getCell(column).text.replace(/[\r\n\t]+/g, " ").trim());
      }
      const rendered = `row ${rowNumber}: ${cells.join("\t")}`;
      totalLength += rendered.length;
      if (totalLength > MAX_EXTRACTED_TEXT_CHARS) {
        throw new Error("extracted spreadsheet text exceeds the supported prompt size");
      }
      rows.push(rendered);
    });
    const section = `[Sheet: ${worksheet.name}]\n${rows.join("\n")}`;
    totalLength += section.length;
    if (totalLength > MAX_EXTRACTED_TEXT_CHARS) {
      throw new Error("extracted spreadsheet text exceeds the supported prompt size");
    }
    sheets.push(section);
  });
  if (sheets.length === 0 || !sheets.some(sheet => /\nrow\s+\d+:/i.test(sheet))) {
    throw new Error("spreadsheet contains no readable cells");
  }
  return `[Bridge-extracted Excel workbook]\n${sheets.join("\n\n")}\n[End Bridge-extracted Excel workbook]`;
}

export async function materializeToolResultMedia(
  messages: CanonicalMessage[],
  context: ToolResultMediaContext,
): Promise<void> {
  const toolCalls = new Map(context.toolCalls.map(call => [call.id, call]));
  const workspaceRoot = context.workspaceRoot;
  for (const message of messages) {
    for (const part of message.parts) {
      if (part.type !== "tool_result" || !part.toolResult) continue;
      const result = part.toolResult;
      const toolCall = toolCalls.get(result.toolUseId);
      if (!toolCall) continue;
      const mediaItems = result.media ?? [];
      const extracted: string[] = [];
      const errors: string[] = [];
      for (const media of mediaItems) {
        if (media.type === "document" && media.mediaType.toLowerCase() === "application/pdf") {
          try {
            extracted.push(await extractPdfText(media.data));
          } catch (error) {
            errors.push(error instanceof Error ? error.message : "PDF extraction failed");
          }
          continue;
        }
        errors.push(`${media.type} content is not supported by the text-only DeepSeek Web transport`);
      }
      if (extracted.length > 0) result.content = appendContent(result.content, extracted.join("\n\n"));
      if (errors.length > 0) {
        result.content = appendContent(
          result.content,
          `[Bridge media processing error]\n${errors.join("; ")}\nUse another real tool that returns textual evidence.`,
        );
        result.isError = true;
      }
      delete result.media;

      const requestedPath = toolCall?.name.toLowerCase() === "read"
        ? [toolCall.arguments.file_path, toolCall.arguments.path]
          .find((value): value is string => typeof value === "string")
        : undefined;
      if (result.isError === true
        && workspaceRoot
        && requestedPath
        && /\.xlsx$/i.test(requestedPath.trim())
        && result.content.length <= 2048
        && UNSUPPORTED_BINARY_RESULT.test(result.content)
        && !INDEPENDENT_FILE_FAILURE.test(result.content)) {
        try {
          result.content = await extractXlsxText(workspaceRoot, requestedPath);
          result.isError = false;
        } catch {
          // Preserve the real failed tool result when the exact requested workbook
          // cannot be safely materialized from the local workspace.
        }
      }
    }
  }
}
