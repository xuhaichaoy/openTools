/**
 * 拼音搜索工具 — 支持拼音全拼、首字母、中文混合匹配
 */
import { pinyin, match as pinyinMatch } from 'pinyin-pro'

/**
 * 判断文本是否匹配关键词（支持拼音）
 * 返回匹配分数，0 表示不匹配
 */
export function pinyinScore(text: string, keyword: string): number {
  if (!text || !keyword) return 0

  const textLower = text.toLowerCase()
  const keyLower = keyword.toLowerCase()

  // 1) 完全匹配 → 100
  if (textLower === keyLower) return 100

  // 2) 原文前缀匹配 → 90
  if (textLower.startsWith(keyLower)) return 90

  // 3) 原文包含匹配 → 70
  if (textLower.includes(keyLower)) return 70

  // 4) 拼音匹配（全拼或首字母）
  const indices = pinyinMatch(text, keyword, { precision: 'start' })
  if (indices && indices.length > 0) {
    // 首字母能连续匹配 → 高分
    return 60
  }

  // 5) 宽松拼音匹配
  const indicesAny = pinyinMatch(text, keyword, { precision: 'any' })
  if (indicesAny && indicesAny.length > 0) {
    return 40
  }

  // 6) 拼音全拼包含匹配
  const fullPinyin = pinyin(text, { toneType: 'none', type: 'array' }).join('')
  if (fullPinyin.includes(keyLower)) {
    return 50
  }

  // 7) 拼音首字母
  const initials = pinyin(text, { pattern: 'first', toneType: 'none', type: 'array' }).join('')
  if (initials.includes(keyLower)) {
    return 45
  }

  return 0
}

/**
 * 综合搜索匹配 — 检查多个字段
 * @param fields 要搜索的字段值列表 (按权重从高到低排列)
 * @param keyword 搜索关键词
 * @returns 总分
 */
export function multiFieldPinyinScore(fields: string[], keyword: string): number {
  if (!keyword.trim()) return 0

  const keywords = keyword.trim().split(/\s+/)
  let totalScore = 0

  for (const kw of keywords) {
    let bestKeywordScore = 0
    for (let i = 0; i < fields.length; i++) {
      const field = fields[i]
      if (!field) continue
      const weight = Math.max(1, fields.length - i) // 越前面的字段权重越高
      const score = pinyinScore(field, kw) * weight
      bestKeywordScore = Math.max(bestKeywordScore, score)
    }
    totalScore += bestKeywordScore
  }

  return totalScore
}

/**
 * 获取拼音匹配的字符索引（用于高亮显示）
 */
export function getPinyinMatchIndices(text: string, keyword: string): number[] | null {
  if (!text || !keyword) return null
  return pinyinMatch(text, keyword) ?? null
}
