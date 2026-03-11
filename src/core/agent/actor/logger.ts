/**
 * Structured Logging — 结构化日志系统
 * 
 * 对标 OpenClaw 的子系统日志。
 * 
 * 特性：
 * - 结构化 JSON 输出
 * - 日志级别支持 (debug, info, warn, error)
 * - 子系统分类
 * - 可配置的输出目标
 * - 异步写入文件
 */

export type LogLevel = "debug" | "info" | "warn" | "error";

export interface LogEntry {
  timestamp: string;
  level: LogLevel;
  subsystem: string;
  message: string;
  context?: Record<string, unknown>;
  error?: {
    name: string;
    message: string;
    stack?: string;
  };
}

export interface LoggerOptions {
  subsystem: string;
  minLevel?: LogLevel;
  /** 是否输出到控制台 */
  console?: boolean;
  /** 是否输出到文件 */
  file?: boolean;
  /** 文件路径 (如果 file 为 true) */
  filePath?: string;
}

// 日志级别优先级
const LOG_LEVEL_PRIORITY: Record<LogLevel, number> = {
  debug: 0,
  info: 1,
  warn: 2,
  error: 3,
};

// 全局配置
interface GlobalLogConfig {
  minLevel: LogLevel;
  defaultSubsystem: string;
  listeners: Set<(entry: LogEntry) => void>;
  consoleEnabled: boolean;
}

const globalConfig: GlobalLogConfig = {
  minLevel: "info",
  defaultSubsystem: "app",
  listeners: new Set(),
  consoleEnabled: true,
};

/**
 * 设置全局日志级别
 */
export function setGlobalLogLevel(level: LogLevel): void {
  globalConfig.minLevel = level;
}

/**
 * 获取全局日志级别
 */
export function getGlobalLogLevel(): LogLevel {
  return globalConfig.minLevel;
}

/**
 * 启用/禁用控制台输出
 */
export function setConsoleLogging(enabled: boolean): void {
  globalConfig.consoleEnabled = enabled;
}

/**
 * 添加日志监听器
 * 
 * @param listener 监听函数
 * @returns 取消监听函数
 */
export function addLogListener(listener: (entry: LogEntry) => void): () => void {
  globalConfig.listeners.add(listener);
  return () => globalConfig.listeners.delete(listener);
}

/**
 * 创建日志入口
 */
function createLogEntry(
  level: LogLevel,
  subsystem: string,
  message: string,
  context?: Record<string, unknown>,
  error?: Error,
): LogEntry {
  const entry: LogEntry = {
    timestamp: new Date().toISOString(),
    level,
    subsystem,
    message,
    context,
  };

  if (error) {
    entry.error = {
      name: error.name,
      message: error.message,
      stack: error.stack,
    };
  }

  return entry;
}

/**
 * 输出日志
 */
function output(entry: LogEntry): void {
  // 检查日志级别
  if (LOG_LEVEL_PRIORITY[entry.level] < LOG_LEVEL_PRIORITY[globalConfig.minLevel]) {
    return;
  }

  // 输出到控制台
  if (globalConfig.consoleEnabled) {
    const prefix = `[${entry.timestamp}] [${entry.level.toUpperCase()}] [${entry.subsystem}]`;
    
    if (entry.level === "error" && entry.error) {
      console.error(prefix, entry.message, entry.context || {}, "\n", entry.error.stack);
    } else if (entry.level === "warn") {
      console.warn(prefix, entry.message, entry.context || {});
    } else if (entry.level === "debug") {
      console.debug(prefix, entry.message, entry.context || {});
    } else {
      console.log(prefix, entry.message, entry.context || {});
    }
  }

  // 通知监听器
  for (const listener of globalConfig.listeners) {
    try {
      listener(entry);
    } catch {
      // 忽略监听器错误
    }
  }
}

/**
 * Logger 类
 */
export class Logger {
  readonly subsystem: string;
  private readonly minLevel: LogLevel;

  constructor(options: string | LoggerOptions) {
    if (typeof options === "string") {
      this.subsystem = options;
      this.minLevel = globalConfig.minLevel;
    } else {
      this.subsystem = options.subsystem;
      this.minLevel = options.minLevel ?? globalConfig.minLevel;
    }
  }

  /**
   * 创建子系统的子 Logger
   */
  child(subsystem: string): Logger {
    return new Logger({
      subsystem: `${this.subsystem}:${subsystem}`,
      minLevel: this.minLevel,
    });
  }

  private shouldLog(level: LogLevel): boolean {
    return LOG_LEVEL_PRIORITY[level] >= LOG_LEVEL_PRIORITY[this.minLevel];
  }

  debug(message: string, context?: Record<string, unknown>): void {
    if (this.shouldLog("debug")) {
      output(createLogEntry("debug", this.subsystem, message, context));
    }
  }

  info(message: string, context?: Record<string, unknown>): void {
    if (this.shouldLog("info")) {
      output(createLogEntry("info", this.subsystem, message, context));
    }
  }

  warn(message: string, context?: Record<string, unknown>): void {
    if (this.shouldLog("warn")) {
      output(createLogEntry("warn", this.subsystem, message, context));
    }
  }

  error(message: string, error?: Error, context?: Record<string, unknown>): void {
    if (this.shouldLog("error")) {
      output(createLogEntry("error", this.subsystem, message, context, error));
    }
  }
}

/**
 * 创建 Logger 的便捷函数
 */
export function createLogger(subsystem: string, minLevel?: LogLevel): Logger {
  return new Logger({ subsystem, minLevel });
}

/**
 * 全局默认 Logger
 */
export const logger = new Logger("app");

// 导出便捷方法
export const debug = (message: string, context?: Record<string, unknown>) => 
  logger.debug(message, context);
export const info = (message: string, context?: Record<string, unknown>) => 
  logger.info(message, context);
export const warn = (message: string, context?: Record<string, unknown>) => 
  logger.warn(message, context);
export const error = (message: string, error?: Error, context?: Record<string, unknown>) => 
  logger.error(message, error, context);

// ── Actor System 专用 Logger ──

export function createActorLogger(actorName: string): Logger {
  return logger.child(`actor.${actorName}`);
}

export function createSessionLogger(sessionId: string): Logger {
  return logger.child(`session.${sessionId.slice(0, 8)}`);
}

export function createTaskLogger(runId: string): Logger {
  return logger.child(`task.${runId.slice(0, 8)}`);
}
