/**
 * 统一错误处理模块
 *
 * 所有错误走统一管道：分级处理 + 日志记录 + 可选用户通知。
 * 取代散落在各处的 console.error / 空 catch。
 */

// ── 错误分级 ──

export enum ErrorLevel {
  /** 应用不可用，需要重启 */
  Fatal = "fatal",
  /** 操作失败，可重试 */
  Recoverable = "error",
  /** 非阻塞性问题，仅提示 */
  Warning = "warning",
}

// ── Toast 回调（由 main.tsx 初始化注入，避免循环依赖） ──

type ToastFn = (type: "success" | "error" | "warning" | "info", message: string) => void;

let _toastFn: ToastFn | null = null;

/** 由 ToastProvider 在挂载时调用，注入全局 toast */
export function registerToast(fn: ToastFn) {
  _toastFn = fn;
}

// ── 核心处理器 ──

export interface HandleErrorOptions {
  /** 错误分级，默认 Recoverable */
  level?: ErrorLevel;
  /** 业务上下文描述，如 "加载书签" "AI对话" */
  context?: string;
  /** true = 只记日志不弹 toast（默认 false） */
  silent?: boolean;
}

/**
 * 统一错误处理入口
 *
 * @example
 * try { ... } catch (e) { handleError(e, { context: '加载书签' }) }
 */
export function handleError(error: unknown, options?: HandleErrorOptions): void {
  const level = options?.level ?? ErrorLevel.Recoverable;
  const context = options?.context;
  const silent = options?.silent ?? false;

  // 1. 提取错误信息
  const message = extractMessage(error);
  const prefix = context ? `[${context}]` : "[Error]";

  // 2. 日志记录（始终记录）
  switch (level) {
    case ErrorLevel.Fatal:
      console.error(`🔴 ${prefix}`, error);
      break;
    case ErrorLevel.Recoverable:
      console.error(`🟡 ${prefix}`, error);
      break;
    case ErrorLevel.Warning:
      console.warn(`⚠️ ${prefix}`, error);
      break;
  }

  // 3. 用户通知（非 silent 时）
  if (!silent && _toastFn) {
    const displayMsg = context ? `${context}失败` : message;
    switch (level) {
      case ErrorLevel.Fatal:
        _toastFn("error", `${displayMsg}，请重启应用`);
        break;
      case ErrorLevel.Recoverable:
        _toastFn("error", displayMsg);
        break;
      case ErrorLevel.Warning:
        _toastFn("warning", displayMsg);
        break;
    }
  }
}

// ── 便捷包装器 ──

/**
 * 包装一个异步操作，自动处理错误
 *
 * @returns 操作成功返回结果，失败返回 undefined
 *
 * @example
 * const docs = await withErrorHandler(() => invoke('rag_list_docs'), '加载文档');
 */
export async function withErrorHandler<T>(
  fn: () => Promise<T>,
  context: string,
  options?: { silent?: boolean; level?: ErrorLevel },
): Promise<T | undefined> {
  try {
    return await fn();
  } catch (e) {
    handleError(e, { context, ...options });
    return undefined;
  }
}

/**
 * 包装一个异步操作，失败时抛出（调用方需自行处理）。
 * 与 withErrorHandler 的区别：错误仍会被记录和通知，但会继续抛出。
 */
export async function withErrorHandlerThrow<T>(
  fn: () => Promise<T>,
  context: string,
  options?: { silent?: boolean; level?: ErrorLevel },
): Promise<T> {
  try {
    return await fn();
  } catch (e) {
    handleError(e, { context, ...options });
    throw e;
  }
}

// ── 内部工具 ──

function extractMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  if (typeof error === "string") return error;
  try {
    return JSON.stringify(error);
  } catch {
    return "未知错误";
  }
}
