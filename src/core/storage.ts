/**
 * 统一持久化工具
 *
 * 提供三层能力：
 * 1. tauriStorage — zustand persist 中间件适配器，基于 @tauri-apps/plugin-store
 * 2. createDebouncedPersister — 通用防抖持久化工厂（用于 AI 对话 / Agent 会话等大体量数据）
 * 3. getTauriStore — 获取共享 Tauri Store 实例
 */

import { load, type Store } from "@tauri-apps/plugin-store";
import { createJSONStorage, type StateStorage } from "zustand/middleware";
import { PERSIST_DEBOUNCE_MS } from "./constants";
import { handleError } from "./errors";

// ── Tauri Store 实例管理 ──

const storeCache = new Map<string, ReturnType<typeof load>>();

/**
 * 获取 / 创建 Tauri Store 实例（单例缓存）
 *
 * @param filename  存储文件名，如 "auth.json"、"app-settings.json"
 */
export function getTauriStore(filename: string): Promise<Store> {
  let cached = storeCache.get(filename);
  if (!cached) {
    cached = load(filename, { defaults: {}, autoSave: true });
    storeCache.set(filename, cached);
  }
  return cached;
}

// ── Zustand persist 适配器 ──

/**
 * 创建基于 Tauri Store 的 zustand persist StateStorage
 *
 * @param filename  Tauri Store 文件名
 * @param errorCtx  出错时的上下文描述
 */
export function createTauriStorage(
  filename: string,
  errorCtx = "持久化",
): StateStorage {
  return {
    getItem: async (name: string): Promise<string | null> => {
      try {
        const store = await getTauriStore(filename);
        const value = await store.get<string>(name);
        return value ?? null;
      } catch (e) {
        handleError(e, { context: `读取${errorCtx}`, silent: true });
        return null;
      }
    },
    setItem: async (name: string, value: string): Promise<void> => {
      try {
        const store = await getTauriStore(filename);
        await store.set(name, value);
        await store.save();
      } catch (e) {
        handleError(e, { context: `保存${errorCtx}`, silent: true });
      }
    },
    removeItem: async (name: string): Promise<void> => {
      try {
        const store = await getTauriStore(filename);
        await store.delete(name);
        await store.save();
      } catch (e) {
        handleError(e, { context: `删除${errorCtx}`, silent: true });
      }
    },
  };
}

/**
 * 便捷方法：创建 zustand persist 使用的 storage 选项
 *
 * 用法：
 *   persist(stateCreator, { name: "key", storage: tauriPersistStorage("settings.json") })
 */
export function tauriPersistStorage(filename: string, errorCtx?: string) {
  return createJSONStorage(() => createTauriStorage(filename, errorCtx));
}

// ── 通用防抖持久化 ──

export interface DebouncedPersister {
  /** 请求一次持久化（自动防抖） */
  trigger: () => void;
  /** 立即执行持久化（跳过防抖） */
  flush: () => void;
  /** 取消待执行的持久化 */
  cancel: () => void;
}

/**
 * 创建防抖持久化器
 *
 * @param persistFn  实际执行持久化的异步函数
 * @param debounceMs 防抖延迟（默认使用 PERSIST_DEBOUNCE_MS）
 */
export function createDebouncedPersister(
  persistFn: () => void | Promise<void>,
  debounceMs = PERSIST_DEBOUNCE_MS,
): DebouncedPersister {
  let timer: ReturnType<typeof setTimeout> | null = null;

  const flush = () => {
    if (timer) {
      clearTimeout(timer);
      timer = null;
    }
    persistFn();
  };

  const cancel = () => {
    if (timer) {
      clearTimeout(timer);
      timer = null;
    }
  };

  const trigger = () => {
    cancel();
    timer = setTimeout(flush, debounceMs);
  };

  return { trigger, flush, cancel };
}
