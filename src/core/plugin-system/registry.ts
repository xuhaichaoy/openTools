import type { MToolsPlugin, PluginAction } from "./plugin-interface";
import { multiFieldPinyinScore } from "@/utils/pinyin-search";

/**
 * 插件注册中心 — 统一管理内置插件的注册、查询、搜索
 */
class PluginRegistry {
  private plugins: Map<string, MToolsPlugin> = new Map();

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

  /**
   * 搜索插件（拼音 + 多字段模糊匹配）
   * 返回按相关性排序的结果
   */
  search(keyword: string): { plugin: MToolsPlugin; score: number }[] {
    if (!keyword) return [];
    return this.getAll()
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
   * 获取所有插件暴露给 AI 的 actions
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
    for (const plugin of this.plugins.values()) {
      if (plugin.actions) {
        for (const action of plugin.actions) {
          result.push({ pluginId: plugin.id, pluginName: plugin.name, action });
        }
      }
    }
    return result;
  }
}

/** 全局单例 */
export const registry = new PluginRegistry();
