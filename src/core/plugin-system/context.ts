/**
 * PluginContext — 统一的插件上下文接口
 *
 * 所有内置插件通过 PluginContext 访问核心能力，
 * 避免直接 import 核心模块产生强耦合。
 */

import type { MToolsAI } from "./plugin-interface";
import type { PluginStorage } from "./storage";
import {
  emitPluginEvent,
  onPluginEvent,
  oncePluginEvent,
} from "./event-bus";

export interface PluginContext {
  /** Core Shell 提供的 AI SDK */
  ai: MToolsAI;
  /** 插件独立的持久化存储 */
  storage: PluginStorage;
  /** 插件事件系统 */
  events: {
    emit: typeof emitPluginEvent;
    on: typeof onPluginEvent;
    once: typeof oncePluginEvent;
  };
}

/** 构造 PluginContext 实例 */
export function createPluginContext(
  ai: MToolsAI,
  storage: PluginStorage,
): PluginContext {
  return {
    ai,
    storage,
    events: {
      emit: emitPluginEvent,
      on: onPluginEvent,
      once: oncePluginEvent,
    },
  };
}
