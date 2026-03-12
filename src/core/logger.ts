/**
 * 统一日志系统
 *
 * 提供分级日志（debug/info/warn/error）、模块标签、
 * 日志缓冲和可选的远程上报接口。
 *
 * 用法：
 *   import { createLogger } from "@/core/logger";
 *   const log = createLogger("AgentActor");
 *   log.info("Task completed", { taskId, elapsed });
 *   log.error("Execution failed", error);
 */

export type LogLevel = "debug" | "info" | "warn" | "error";

const LEVEL_PRIORITY: Record<LogLevel, number> = {
  debug: 0,
  info: 1,
  warn: 2,
  error: 3,
};

export interface LogEntry {
  timestamp: number;
  level: LogLevel;
  module: string;
  message: string;
  data?: unknown;
}

type LogSink = (entry: LogEntry) => void;

/** Ring buffer for recent log entries */
const LOG_BUFFER_SIZE = 500;
const logBuffer: LogEntry[] = [];
let bufferIndex = 0;

/** Global minimum log level */
let globalMinLevel: LogLevel = "debug";

/** Registered external sinks (e.g. file persistence, remote API) */
const sinks: LogSink[] = [];

export function setGlobalLogLevel(level: LogLevel): void {
  globalMinLevel = level;
}

export function addLogSink(sink: LogSink): () => void {
  sinks.push(sink);
  return () => {
    const idx = sinks.indexOf(sink);
    if (idx >= 0) sinks.splice(idx, 1);
  };
}

/** Get recent log entries (newest last) */
export function getRecentLogs(count = 100): LogEntry[] {
  const total = Math.min(count, logBuffer.length);
  if (logBuffer.length <= LOG_BUFFER_SIZE) {
    return logBuffer.slice(-total);
  }
  const start = (bufferIndex - total + LOG_BUFFER_SIZE) % LOG_BUFFER_SIZE;
  const result: LogEntry[] = [];
  for (let i = 0; i < total; i++) {
    result.push(logBuffer[(start + i) % LOG_BUFFER_SIZE]);
  }
  return result;
}

/** Get recent error logs */
export function getRecentErrors(count = 50): LogEntry[] {
  return getRecentLogs(LOG_BUFFER_SIZE)
    .filter((e) => e.level === "error")
    .slice(-count);
}

function pushToBuffer(entry: LogEntry): void {
  if (logBuffer.length < LOG_BUFFER_SIZE) {
    logBuffer.push(entry);
  } else {
    logBuffer[bufferIndex] = entry;
  }
  bufferIndex = (bufferIndex + 1) % LOG_BUFFER_SIZE;
}

function emit(entry: LogEntry): void {
  if (LEVEL_PRIORITY[entry.level] < LEVEL_PRIORITY[globalMinLevel]) return;
  pushToBuffer(entry);

  // Console output
  const prefix = `[${entry.module}]`;
  const consoleFn = entry.level === "error"
    ? console.error
    : entry.level === "warn"
      ? console.warn
      : entry.level === "debug"
        ? console.debug
        : console.log;

  if (entry.data !== undefined) {
    consoleFn(prefix, entry.message, entry.data);
  } else {
    consoleFn(prefix, entry.message);
  }

  // Dispatch to external sinks
  for (const sink of sinks) {
    try {
      sink(entry);
    } catch {
      // prevent sink errors from breaking the app
    }
  }
}

export interface Logger {
  debug(message: string, data?: unknown): void;
  info(message: string, data?: unknown): void;
  warn(message: string, data?: unknown): void;
  error(message: string, data?: unknown): void;
  /** Create a child logger with a sub-module tag */
  child(subModule: string): Logger;
}

export function createLogger(module: string): Logger {
  const make = (level: LogLevel) => (message: string, data?: unknown) => {
    emit({ timestamp: Date.now(), level, module, message, data });
  };

  return {
    debug: make("debug"),
    info: make("info"),
    warn: make("warn"),
    error: make("error"),
    child(subModule: string): Logger {
      return createLogger(`${module}:${subModule}`);
    },
  };
}
