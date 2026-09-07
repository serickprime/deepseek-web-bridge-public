import { Redactor } from "./redaction.js";
import { hmacFingerprint, randomToken } from "./crypto.js";

export type LogLevel = "debug" | "info" | "warn" | "error";

const LEVEL_ORDER: Record<LogLevel, number> = { debug: 10, info: 20, warn: 30, error: 40 };
const PROCESS_CORRELATION_SALT = randomToken(32);

export interface LogFields {
  [key: string]: unknown;
}

export interface LoggerOptions {
  level?: LogLevel;
  redactor?: Redactor;
  requestRef?: string;
  sinks?: Array<(entry: LogEntry) => void>;
}

export type OpaqueRefDomain = "client" | "upstream" | "chat" | "call";

export interface LogEntry {
  ts: string;
  level: LogLevel;
  msg: string;
  request_ref?: string;
  fields: LogFields;
}

export class Logger {
  private readonly level: LogLevel;
  private readonly minLevel: number;
  readonly redactor: Redactor;
  private readonly requestRef?: string;
  private readonly sinks: Array<(entry: LogEntry) => void>;

  constructor(options: LoggerOptions = {}) {
    this.level = options.level ?? "info";
    this.minLevel = LEVEL_ORDER[this.level];
    this.redactor = options.redactor ?? new Redactor();
    this.requestRef = options.requestRef;
    this.sinks = options.sinks ?? [];
  }

  withRequestRef(requestRef: string): Logger {
    return new Logger({
      level: this.level,
      redactor: this.redactor,
      requestRef,
      sinks: this.sinks,
    });
  }

  child(fields: LogFields): Logger {
    const base = this;
    return new Logger({
      redactor: this.redactor,
      requestRef: this.requestRef,
      level: this.level,
      sinks: [
        entry => {
          base.emit(entry.level, entry.msg, { ...entry.fields, ...fields });
        },
      ],
    });
  }

  opaqueRef(domain: OpaqueRefDomain, value: string | null | undefined): string | undefined {
    if (!value) return undefined;
    return `${domain}_${hmacFingerprint(`${domain}:${value}`, PROCESS_CORRELATION_SALT)}`;
  }

  debug(msg: string, fields: LogFields = {}): void {
    this.emit("debug", msg, fields);
  }

  info(msg: string, fields: LogFields = {}): void {
    this.emit("info", msg, fields);
  }

  warn(msg: string, fields: LogFields = {}): void {
    this.emit("warn", msg, fields);
  }

  error(msg: string, fields: LogFields = {}): void {
    this.emit("error", msg, fields);
  }

  private emit(level: LogLevel, msg: string, fields: LogFields): void {
    if (LEVEL_ORDER[level] < this.minLevel) return;
    const entry: LogEntry = {
      ts: new Date().toISOString(),
      level,
      msg,
      request_ref: this.requestRef,
      fields: this.redactFields(fields),
    };
    if (this.sinks.length > 0) {
      for (const sink of this.sinks) sink(entry);
      return;
    }
    this.writeToStdout(entry);
  }

  private redactFields(fields: LogFields): LogFields {
    const out: LogFields = {};
    for (const [key, value] of Object.entries(fields)) {
      out[key] = this.redactor.redactValue(key, value);
    }
    return out;
  }

  private writeToStdout(entry: LogEntry): void {
    const line = JSON.stringify(entry);
    if (entry.level === "error" || entry.level === "warn") {
      process.stderr.write(line + "\n");
    } else {
      process.stdout.write(line + "\n");
    }
  }
}
