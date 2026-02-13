import type { PluginInstance, PluginFeature, PluginCommand, PluginMatchResult } from './types'
import { pinyinScore } from '@/utils/pinyin-search'

/**
 * 匹配文本（支持拼音）
 */
function containsMatch(text: string, keyword: string): boolean {
  return pinyinScore(text, keyword) > 0
}

/**
 * 匹配单个指令
 */
function matchCommand(
  cmd: string | PluginCommand,
  input: string
): { matched: boolean; score: number } {
  if (typeof cmd === 'string') {
    // 字符串指令 — 模糊匹配
    if (containsMatch(cmd, input)) {
      // 完全匹配给更高分
      if (cmd.toLowerCase() === input.toLowerCase()) {
        return { matched: true, score: 100 }
      }
      // 前缀匹配
      if (cmd.toLowerCase().startsWith(input.toLowerCase())) {
        return { matched: true, score: 80 }
      }
      // 包含匹配
      return { matched: true, score: 50 }
    }
    return { matched: false, score: 0 }
  }

  // 对象类型指令
  switch (cmd.type) {
    case 'text': {
      // 文本匹配（label 匹配）
      if (containsMatch(cmd.label, input)) {
        return { matched: true, score: 70 }
      }
      return { matched: false, score: 0 }
    }

    case 'regex': {
      // 正则匹配
      if (cmd.match) {
        try {
          const regex = new RegExp(cmd.match)
          if (regex.test(input)) {
            return { matched: true, score: 90 }
          }
        } catch {
          // 正则无效，忽略
        }
      }
      // 也检查 label
      if (containsMatch(cmd.label, input)) {
        return { matched: true, score: 60 }
      }
      return { matched: false, score: 0 }
    }

    case 'over': {
      // 超级面板（全局匹配，不需要精确匹配）
      return { matched: true, score: 10 }
    }

    default:
      return { matched: false, score: 0 }
  }
}

/**
 * 对所有插件执行指令匹配
 */
export function matchPlugins(
  plugins: PluginInstance[],
  input: string
): PluginMatchResult[] {
  if (!input.trim()) return []

  const results: PluginMatchResult[] = []

  for (const plugin of plugins) {
    if (!plugin.enabled) continue

    for (const feature of plugin.manifest.features) {
      // 检查平台兼容性
      if (feature.platform && feature.platform.length > 0) {
        // 简化：Tauri 环境下当前平台
        const currentPlatform = navigator.platform.startsWith('Mac') ? 'darwin' :
          navigator.platform.startsWith('Win') ? 'win' : 'linux'
        if (!feature.platform.includes(currentPlatform)) continue
      }

      let bestScore = 0
      let bestCmd: string | PluginCommand | null = null

      for (const cmd of feature.cmds) {
        const { matched, score } = matchCommand(cmd, input)
        if (matched && score > bestScore) {
          bestScore = score
          bestCmd = cmd
        }
      }

      // 也检查 feature 的 explain（功能说明）
      if (containsMatch(feature.explain, input)) {
        const explainScore = 40
        if (explainScore > bestScore) {
          bestScore = explainScore
          bestCmd = feature.cmds[0] || feature.code
        }
      }

      // 也检查插件名
      if (containsMatch(plugin.manifest.pluginName, input)) {
        const nameScore = 30
        if (nameScore > bestScore) {
          bestScore = nameScore
          bestCmd = feature.cmds[0] || feature.code
        }
      }

      if (bestCmd && bestScore > 0) {
        results.push({
          plugin,
          feature,
          matchedCmd: bestCmd,
          score: bestScore,
        })
      }
    }
  }

  // 按分数降序排列
  results.sort((a, b) => b.score - a.score)
  return results
}
