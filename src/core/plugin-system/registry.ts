import type { MToolsPlugin, PluginAction } from "./plugin-interface";
import type { ExternalPluginAction } from "./types";
import { multiFieldPinyinScore } from "@/utils/pinyin-search";

/** 外部插件注册的 action 记录 */
interface ExternalActionEntry {
  pluginId: string;
  pluginName: string;
  action: ExternalPluginAction;
}

/**
 * 插件注册中心 — 统一管理内置插件的注册、查询、搜索
 */
class PluginRegistry {
  private plugins: Map<string, MToolsPlugin> = new Map();
  /** 外部插件声明的 AI actions */
  private externalActions: ExternalActionEntry[] = [];

  /** 注册一个内置插件 */
  register(plugin: MToolsPlugin) {
    if (this.plugins.has(plugin.id)) {
      console.warn(`[Registry] 插件 ${plugin.id} 已注册，覆盖`);
    }
    this.plugins.set(plugin.id, plugin);
  }

  /** 批量注册（先清空再注册，确保 HMR 时不残留旧插件） */
  registerAll(plugins: MToolsPlugin[]) {
    this.plugins.clear();
    plugins.forEach((p) => this.register(p));
  }

  /** 注册外部插件的 AI actions（由 plugin-store loadPlugins 后调用） */
  registerExternalActions(entries: ExternalActionEntry[]) {
    this.externalActions = entries;
  }

  /** 获取指定插件 */
  get(id: string): MToolsPlugin | undefined {
    return this.plugins.get(id);
  }

  /** 通过 viewId 查找插件 */
  getByViewId(viewId: string): MToolsPlugin | undefined {
    for (const plugin of this.plugins.values()) {
      if (plugin.viewId === viewId) return plugin;
    }
    return undefined;
  }

  /** 获取所有插件 */
  getAll(): MToolsPlugin[] {
    return Array.from(this.plugins.values());
  }

  /** 按分类获取 */
  getByCategory(category: MToolsPlugin["category"]): MToolsPlugin[] {
    return this.getAll().filter((p) => p.category === category);
  }

  /** 按层级获取（core / extension） */
  getByTier(tier: "core" | "extension"): MToolsPlugin[] {
    return this.getAll().filter((p) => (p.tier ?? "extension") === tier);
  }

  /** 获取可搜索的插件（排除 searchable: false） */
  getSearchable(): MToolsPlugin[] {
    return this.getAll().filter((p) => p.searchable !== false);
  }

  /**
   * 搜索插件（拼音 + 多字段模糊匹配）
   * 返回按相关性排序的结果（排除 searchable: false 的插件）
   */
  search(keyword: string): { plugin: MToolsPlugin; score: number }[] {
    if (!keyword) return [];
    return this.getSearchable()
      .map((plugin) => ({
        plugin,
        score: multiFieldPinyinScore(
          [plugin.name, plugin.description, ...plugin.keywords, plugin.id],
          keyword,
        ),
      }))
      .filter(({ score }) => score > 0)
      .sort((a, b) => b.score - a.score);
  }

  /**
   * 获取所有插件暴露给 AI 的 actions（内置 + 外部）
   * 用于 AI tool_call 发现
   */
  getAllActions(): {
    pluginId: string;
    pluginName: string;
    action: PluginAction;
  }[] {
    const result: {
      pluginId: string;
      pluginName: string;
      action: PluginAction;
    }[] = [];
    // 内置插件 actions
    for (const plugin of this.plugins.values()) {
      if (plugin.actions) {
        for (const action of plugin.actions) {
          result.push({ pluginId: plugin.id, pluginName: plugin.name, action });
        }
      }
    }
    // 外部插件声明的 actions（通过事件桥执行）
    for (const entry of this.externalActions) {
      result.push({
        pluginId: entry.pluginId,
        pluginName: entry.pluginName,
        action: {
          name: entry.action.name,
          description: entry.action.description,
          parameters: entry.action.parameters,
          execute: async (params, ctx) => {
            // 外部插件的 action 通过 Tauri 事件桥执行
            const { invoke } = await import("@tauri-apps/api/core");
            const result = await invoke<string>("plugin_api_call", {
              pluginId: entry.pluginId,
              method: "mtools_action",
              args: JSON.stringify({ actionName: entry.action.name, params }),
            });
            return result;
          },
        },
      });
    }
    return result;
  }

  /** 获取外部插件的 actions（仅描述信息，用于 Agent 工具发现） */
  getExternalActions(): ExternalActionEntry[] {
    return [...this.externalActions];
  }
}

/** 全局单例 */
export const registry = new PluginRegistry();
