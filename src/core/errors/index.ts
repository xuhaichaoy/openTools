/**
 * 统一错误处理模块
 *
 * 所有错误走统一管道：分级处理 + 日志记录 + 可选用户通知。
 */

// ── 错误分级 ──

export const ErrorLevel = {
  /** 应用不可用，需要重启 */
  Fatal: "fatal",
  /** 操作失败，可重试 */
  Recoverable: "error",
  /** 非阻塞性问题，仅提示 */
  Warning: "warning",
} as const;

export type ErrorLevel = (typeof ErrorLevel)[keyof typeof ErrorLevel];

// ── Toast 回调（由 main.tsx 初始化注入，避免循环依赖） ──

type ToastFn = (
  type: "success" | "error" | "warning" | "info",
  message: string,
) => void;

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

const CODE_MESSAGE_MAP: Record<string, string> = {
  PLAN_REQUIRED: "个人云同步需要会员，仅本地可用",
  TEAM_SUBSCRIPTION_REQUIRED: "团队会员未开通或已到期",
  TEAM_TRIAL_EXPIRED: "团队试用已到期",
  TEAM_QUOTA_EXCEEDED: "本月额度已用尽",
  TEAM_MODEL_UNAVAILABLE: "团队模型不可用",
  NO_ACTIVE_TEAM_MODEL: "团队暂无可用模型",
  TEAM_ID_REQUIRED: "缺少团队信息，请先选择团队",
  PLATFORM_AI_NOT_AVAILABLE: "平台 AI 暂未开放",
  TEAM_WORKFLOW_TEMPLATE_NOT_FOUND: "团队工作流模板不存在",
  INVALID_RESPONSE_SHAPE: "服务返回结构异常",
  NETWORK_ERROR: "网络异常，请检查网络连接",
};

interface ErrorMeta {
  message: string;
  code?: string;
  details?: unknown;
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
  const isUnauthorized =
    error && typeof error === "object" && (error as any).code === "UNAUTHORIZED";
  const silent = options?.silent ?? isUnauthorized ?? false;

  const meta = extractErrorMeta(error);
  const baseMessage =
    (meta.code && CODE_MESSAGE_MAP[meta.code]) || meta.message || "未知错误";
  const displayMsg = context ? `${context}：${baseMessage}` : baseMessage;
  const prefix = context ? `[${context}]` : "[Error]";

  // 1. 日志记录（始终记录）
  switch (level) {
    case ErrorLevel.Fatal:
      console.error(`${prefix}`, error);
      break;
    case ErrorLevel.Recoverable:
      console.error(`${prefix}`, error);
      break;
    case ErrorLevel.Warning:
      console.warn(`${prefix}`, error);
      break;
  }

  // 2. 用户通知（非 silent 时）
  if (!silent && _toastFn) {
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

function extractErrorMeta(error: unknown): ErrorMeta {
  if (error && typeof error === "object") {
    const code =
      typeof (error as any).code === "string" ? (error as any).code : undefined;
    const message =
      typeof (error as any).message === "string"
        ? (error as any).message
        : typeof (error as any).error === "string"
          ? (error as any).error
          : undefined;
    const details = (error as any).details;

    if (message) {
      return { message, code, details };
    }
  }

  if (error instanceof Error) {
    return { message: error.message };
  }
  if (typeof error === "string") {
    return { message: error };
  }
  try {
    return { message: JSON.stringify(error) };
  } catch {
    return { message: "未知错误" };
  }
}
