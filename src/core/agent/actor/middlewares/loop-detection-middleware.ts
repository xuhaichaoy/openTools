/**
 * LoopDetectionMiddleware — 将 loop guardrail 从 ReActAgent 常量提升到 runtime 配置层
 *
 * 目前底层 ReActAgent 已有 loop / doom loop 检测实现。
 * 这个 middleware 的职责不是重复实现一套检测器，而是把阈值与豁免工具
 * 显式注入到本轮 Actor runtime，方便后续继续对齐 DeerFlow 的 middleware discipline。
 */

import type { ActorMiddleware, ActorRunContext } from "../actor-middleware";
import type { LoopDetectionConfig } from "../types";

const DEFAULT_LOOP_DETECTION_CONFIG: Required<LoopDetectionConfig> = {
  windowSize: 6,
  repeatThreshold: 3,
  consecutiveFailureLimit: 3,
  consecutiveSameToolLimit: 3,
  exemptTools: [
    "get_current_time",
    "get_system_info",
    "calculate",
    "native_calendar_list",
    "native_reminder_lists",
    "native_shortcuts_list",
    "native_app_list",
    "native_app_list_interactive",
  ],
};

export class LoopDetectionMiddleware implements ActorMiddleware {
  readonly name = "LoopDetection";
  private readonly config?: LoopDetectionConfig;

  constructor(config?: LoopDetectionConfig) {
    this.config = config;
  }

  async apply(ctx: ActorRunContext): Promise<void> {
    const current = ctx.loopDetectionConfig;
    ctx.loopDetectionConfig = {
      ...DEFAULT_LOOP_DETECTION_CONFIG,
      ...(this.config ?? {}),
      ...(current ?? {}),
      exemptTools: [
        ...new Set([
          ...DEFAULT_LOOP_DETECTION_CONFIG.exemptTools,
          ...(this.config?.exemptTools ?? []),
          ...(current?.exemptTools ?? []),
        ]),
      ],
    };
  }
}

export function getDefaultLoopDetectionConfig(): Required<LoopDetectionConfig> {
  return {
    ...DEFAULT_LOOP_DETECTION_CONFIG,
    exemptTools: [...DEFAULT_LOOP_DETECTION_CONFIG.exemptTools],
  };
}
