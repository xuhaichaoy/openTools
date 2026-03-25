/**
 * Announce Delivery — 任务完成通知投递系统
 *
 * 对标 OpenClaw 的 announce 投递能力。
 *
 * 支持的投递方式：
 * - webhook: HTTP POST 请求
 * - email: 发送邮件通知
 *
 * 使用 Hook 系统集成：
 * - 监听 onSpawnTaskEnd 事件
 * - 自动投递任务完成通知
 */

import type { SpawnTaskEndHookContext } from "./actor-system";

export type DeliveryMode = "none" | "webhook" | "email";

export interface DeliveryConfig {
  mode: DeliveryMode;
  /** Webhook URL */
  url?: string;
  /** Email 地址 */
  email?: string;
  /** Email 主题前缀 */
  emailSubjectPrefix?: string;
  /** 自定义 headers */
  headers?: Record<string, string>;
}

/**
 * 投递结果
 */
export interface DeliveryResult {
  success: boolean;
  error?: string;
  attempts: number;
  deliveredAt?: number;
}

/**
 * Webhook 投递器
 */
export async function deliverToWebhook(
  url: string,
  payload: object,
  headers?: Record<string, string>,
): Promise<DeliveryResult> {
  const maxAttempts = 3;
  const delays = [1000, 3000, 5000]; // 重试延迟

  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    try {
      const response = await fetch(url, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          ...headers,
        },
        body: JSON.stringify(payload),
      });

      if (response.ok) {
        return {
          success: true,
          attempts: attempt + 1,
          deliveredAt: Date.now(),
        };
      }

      // 如果是 4xx 错误，不重试
      if (response.status >= 400 && response.status < 500) {
        return {
          success: false,
          error: `Webhook returned ${response.status}: ${response.statusText}`,
          attempts: attempt + 1,
        };
      }
    } catch (err) {
      const error = err instanceof Error ? err.message : "Unknown error";

      // 如果已经达到最大重试次数
      if (attempt === maxAttempts - 1) {
        return {
          success: false,
          error: `Failed after ${maxAttempts} attempts: ${error}`,
          attempts: maxAttempts,
        };
      }
    }

    // 等待后重试
    if (attempt < maxAttempts - 1) {
      await new Promise((resolve) => setTimeout(resolve, delays[attempt]));
    }
  }

  return {
    success: false,
    error: "Max attempts reached",
    attempts: maxAttempts,
  };
}

/**
 * Email 投递器（使用系统 mailto 链接或 API）
 *
 * 注意：在实际生产环境中，应该使用专用的邮件服务 API（如 SendGrid、Mailgun 等）
 * 这里提供两种方式：
 * 1. mailto 链接 - 适用于简单的邮件发送
 * 2. 预留邮件 API 接口 - 便于后续集成
 */
export async function deliverToEmail(
  to: string,
  subject: string,
  body: string,
  _options?: {
    /** 邮件服务 API URL */
    apiUrl?: string;
    /** 邮件服务 API Key */
    apiKey?: string;
  },
): Promise<DeliveryResult> {
  // 方式 1: 使用 mailto 链接（适用于桌面应用）
  // 这会打开系统默认邮件客户端
  const mailtoUrl = `mailto:${to}?subject=${encodeURIComponent(subject)}&body=${encodeURIComponent(body)}`;

  try {
    if (typeof window !== "undefined" && typeof window.open === "function") {
      window.open(mailtoUrl, "_blank");
    } else {
      throw new Error("window.open is not available");
    }

    return {
      success: true,
      attempts: 1,
      deliveredAt: Date.now(),
    };
  } catch (err) {
    // 如果在非 Tauri 环境或打开失败，记录错误
    // 在生产环境中，应该使用邮件服务 API
    const error =
      err instanceof Error ? err.message : "Failed to open mail client";

    return {
      success: false,
      error: `Email delivery not available: ${error}`,
      attempts: 1,
    };
  }
}

/**
 * 构建 announce 消息内容
 */
export function buildAnnounceContent(
  ctx: SpawnTaskEndHookContext,
  options?: {
    includeTask?: boolean;
    includeResult?: boolean;
    includeError?: boolean;
  },
): { title: string; body: string } {
  const { spawnerId, targetId, task, runId, status, result, error } = ctx;

  const title = `[${status === "completed" ? "完成" : "失败"}] 任务通知 - ${runId.slice(0, 8)}`;

  const lines: string[] = [];
  lines.push(
    `任务状态: ${status === "completed" ? "✅ 完成" : "❌ " + status}`,
  );
  lines.push(`执行者: ${targetId}`);
  lines.push(`派发者: ${spawnerId}`);

  if (options?.includeTask !== false) {
    lines.push("");
    lines.push("任务内容:");
    lines.push(task.slice(0, 500) + (task.length > 500 ? "..." : ""));
  }

  if (status === "completed" && result && options?.includeResult !== false) {
    lines.push("");
    lines.push("执行结果:");
    lines.push(result.slice(0, 1000) + (result.length > 1000 ? "..." : ""));
  }

  if (status !== "completed" && error && options?.includeError !== false) {
    lines.push("");
    lines.push("错误信息:");
    lines.push(error);
  }

  lines.push("");
  lines.push(`-- `);
  lines.push(`由 HiClow Agent System 自动发送`);

  return {
    title,
    body: lines.join("\n"),
  };
}

/**
 * 发送 announce 通知
 */
export async function sendAnnounce(
  ctx: SpawnTaskEndHookContext,
  config: DeliveryConfig,
): Promise<DeliveryResult> {
  if (config.mode === "none") {
    return { success: true, attempts: 0 };
  }

  const { title, body } = buildAnnounceContent(ctx);

  if (config.mode === "webhook") {
    if (!config.url) {
      return {
        success: false,
        error: "Webhook URL not configured",
        attempts: 0,
      };
    }

    return deliverToWebhook(
      config.url,
      {
        title,
        body,
        task: ctx.task,
        runId: ctx.runId,
        status: ctx.status,
        result: ctx.result,
        error: ctx.error,
        timestamp: Date.now(),
      },
      config.headers,
    );
  }

  if (config.mode === "email") {
    if (!config.email) {
      return { success: false, error: "Email not configured", attempts: 0 };
    }

    const subject = config.emailSubjectPrefix
      ? `${config.emailSubjectPrefix} ${title}`
      : title;

    return deliverToEmail(config.email, subject, body);
  }

  return {
    success: false,
    error: `Unknown delivery mode: ${config.mode}`,
    attempts: 0,
  };
}

/**
 * 创建 Announce Hook 处理器
 *
 * 用法：
 * ```typescript
 * const announceHandler = createAnnounceHook({
 *   mode: "webhook",
 *   url: "https://example.com/webhook",
 * });
 *
 * actorSystem.registerHook("onSpawnTaskEnd", announceHandler);
 * ```
 */
export function createAnnounceHook(config: DeliveryConfig) {
  return async (ctx: SpawnTaskEndHookContext): Promise<void> => {
    // 只在任务完成或失败时发送通知
    if (ctx.status === "completed" || ctx.status === "error") {
      const result = await sendAnnounce(ctx, config);

      if (!result.success) {
        console.warn(`[Announce] Failed to deliver: ${result.error}`);
      } else {
        console.log(
          `[Announce] Delivered to ${config.mode} (attempts: ${result.attempts})`,
        );
      }
    }
  };
}

/**
 * 默认投递配置（从配置读取）
 */
let defaultDeliveryConfig: DeliveryConfig = { mode: "none" };

/**
 * 设置默认投递配置
 */
export function setDefaultDeliveryConfig(config: DeliveryConfig): void {
  defaultDeliveryConfig = config;
}

/**
 * 获取默认投递配置
 */
export function getDefaultDeliveryConfig(): DeliveryConfig {
  return defaultDeliveryConfig;
}

/**
 * 使用默认配置发送 announce
 */
export async function sendAnnounceWithDefault(
  ctx: SpawnTaskEndHookContext,
): Promise<DeliveryResult> {
  return sendAnnounce(ctx, defaultDeliveryConfig);
}
