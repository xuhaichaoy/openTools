/**
 * 数据工坊 — 前端脚本注册表
 *
 * 提供脚本搜索、分类过滤、AI 匹配等前端逻辑。
 * 实际脚本数据从 Rust 后端加载（扫描 scripts/registry.json 或 script.meta.json）
 */

import type { ScriptMeta, ScriptCategory } from './types'
import { pinyinScore } from '@/utils/pinyin-search'

/** 将脚本列表按分类分组 */
export function groupByCategory(scripts: ScriptMeta[]): ScriptCategory[] {
  const map = new Map<string, ScriptMeta[]>()

  for (const script of scripts) {
    const category = script.category || '未分类'
    if (!map.has(category)) {
      map.set(category, [])
    }
    map.get(category)!.push(script)
  }

  return Array.from(map.entries())
    .map(([name, scripts]) => ({
      name,
      count: scripts.length,
      scripts,
    }))
    .sort((a, b) => b.count - a.count)
}

/** 本地搜索脚本（关键词匹配名称、描述、标签、分类） */
export function searchScripts(scripts: ScriptMeta[], query: string): ScriptMeta[] {
  if (!query.trim()) return scripts

  const keywords = query.toLowerCase().split(/\s+/).filter(Boolean)

  return scripts
    .map((script) => {
      const searchText = [
        script.name,
        script.description,
        script.category,
        ...script.tags,
        script.id,
      ]
        .join(' ')
        .toLowerCase()

      // 计算匹配分数（支持拼音）
      let score = 0
      for (const keyword of keywords) {
        score += pinyinScore(script.name, keyword) * 0.1
        score += pinyinScore(script.description, keyword) * 0.05
        score += pinyinScore(script.category, keyword) * 0.03
        for (const t of script.tags) {
          score += pinyinScore(t, keyword) * 0.04
        }
        if (searchText.includes(keyword)) score += 1
      }

      return { script, score }
    })
    .filter((item) => item.score > 0)
    .sort((a, b) => b.score - a.score)
    .map((item) => item.script)
}

/** 根据 AI 意图匹配脚本（模糊匹配，用于 Agent 选脚本） */
export function matchScriptByIntent(
  scripts: ScriptMeta[],
  intent: string,
): { script: ScriptMeta; confidence: number }[] {
  const keywords = intent.toLowerCase().split(/[\s,，。.、]+/).filter(Boolean)

  return scripts
    .map((script) => {
      let confidence = 0
      const total = keywords.length || 1

      for (const keyword of keywords) {
        // 名称精确包含 +30
        if (script.name.toLowerCase().includes(keyword)) confidence += 30
        // 分类匹配 +20
        if (script.category.toLowerCase().includes(keyword)) confidence += 20
        // 描述匹配 +10
        if (script.description.toLowerCase().includes(keyword)) confidence += 10
        // 标签匹配 +15
        if (script.tags.some((t) => t.toLowerCase().includes(keyword))) confidence += 15
      }

      // 归一化到 0-100
      const maxPossible = total * 75
      confidence = Math.min(Math.round((confidence / maxPossible) * 100), 100)

      return { script, confidence }
    })
    .filter((item) => item.confidence > 10)
    .sort((a, b) => b.confidence - a.confidence)
}

/** 获取脚本需要的凭证列表（去重） */
export function getRequiredCredentials(scripts: ScriptMeta[]): string[] {
  const set = new Set<string>()
  for (const script of scripts) {
    if (script.requires_auth) {
      for (const auth of script.requires_auth) {
        set.add(auth)
      }
    }
  }
  return Array.from(set).sort()
}

/** 格式化预计执行时间 */
export function formatEstimatedTime(time?: string): string {
  if (!time) return '未知'
  return time
}

/** 获取最近使用的脚本（基于执行历史 ID 排序） */
export function getRecentScripts(
  scripts: ScriptMeta[],
  recentIds: string[],
): ScriptMeta[] {
  const idSet = new Set(recentIds)
  return scripts
    .filter((s) => idSet.has(s.id))
    .sort((a, b) => recentIds.indexOf(a.id) - recentIds.indexOf(b.id))
}
