/**
 * 剪贴板 / 选中文本内容类型检测器
 * 识别内容类型并推荐对应的快捷操作
 */

import { handleError } from '@/core/errors'

export type ContentType =
  | 'url'
  | 'json'
  | 'code'
  | 'english'
  | 'chinese'
  | 'file_path'
  | 'timestamp'
  | 'email'
  | 'number'
  | 'general'

export interface DetectionResult {
  type: ContentType
  label: string
  confidence: number // 0-1
}

/** URL 正则 */
const URL_PATTERN = /^https?:\/\/[^\s]+$/i

/** 邮箱 */
const EMAIL_PATTERN = /^[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}$/

/** 文件路径（macOS / Windows / Linux） */
const FILE_PATH_PATTERN = /^(\/[\w\-.]+)+\/?$|^[A-Z]:\\[\w\-.\\ ]+$/i

/** Unix 时间戳（10 位秒或 13 位毫秒） */
const TIMESTAMP_PATTERN = /^\d{10}(\d{3})?$/

/** 纯数字（含小数） */
const NUMBER_PATTERN = /^-?\d+(\.\d+)?$/

/** 代码特征关键词 */
const CODE_INDICATORS = [
  /^(import |from |export |const |let |var |function |class |def |pub fn |async |interface |type )/m,
  /[{};]\s*$/m,
  /=>\s*[{(]/,
  /\b(if|else|for|while|return|switch|case)\s*[\s({]/,
  /<\/?\w+[\s>]/,  // HTML/JSX tags
]

/** JSON 检测 */
function looksLikeJSON(text: string): boolean {
  const trimmed = text.trim()
  if ((trimmed.startsWith('{') && trimmed.endsWith('}')) ||
      (trimmed.startsWith('[') && trimmed.endsWith(']'))) {
    try {
      JSON.parse(trimmed)
      return true
    } catch (e) {
      handleError(e, { context: 'JSON格式检测', silent: true })
      return false
    }
  }
  return false
}

/** 中文字符比例 */
function chineseRatio(text: string): number {
  const chinese = text.match(/[\u4e00-\u9fff]/g)
  return chinese ? chinese.length / text.length : 0
}

/** 英文单词比例 */
function englishWordRatio(text: string): number {
  const words = text.match(/[a-zA-Z]+/g)
  return words ? words.join('').length / text.length : 0
}

/**
 * 检测文本内容类型，返回按置信度排序的结果列表
 */
export function detectContent(text: string): DetectionResult[] {
  const trimmed = text.trim()
  if (!trimmed) return [{ type: 'general', label: '文本', confidence: 1 }]

  const results: DetectionResult[] = []

  // URL
  if (URL_PATTERN.test(trimmed)) {
    results.push({ type: 'url', label: '链接', confidence: 0.95 })
  }

  // 邮箱
  if (EMAIL_PATTERN.test(trimmed)) {
    results.push({ type: 'email', label: '邮箱', confidence: 0.95 })
  }

  // 文件路径
  if (FILE_PATH_PATTERN.test(trimmed)) {
    results.push({ type: 'file_path', label: '文件路径', confidence: 0.9 })
  }

  // 时间戳
  if (TIMESTAMP_PATTERN.test(trimmed)) {
    results.push({ type: 'timestamp', label: '时间戳', confidence: 0.9 })
  }

  // 纯数字
  if (NUMBER_PATTERN.test(trimmed) && !TIMESTAMP_PATTERN.test(trimmed)) {
    results.push({ type: 'number', label: '数字', confidence: 0.85 })
  }

  // JSON
  if (looksLikeJSON(trimmed)) {
    results.push({ type: 'json', label: 'JSON', confidence: 0.95 })
  }

  // 代码
  const codeScore = CODE_INDICATORS.reduce(
    (score, pattern) => score + (pattern.test(trimmed) ? 0.2 : 0),
    0,
  )
  if (codeScore >= 0.4) {
    results.push({ type: 'code', label: '代码', confidence: Math.min(codeScore, 0.95) })
  }

  // 中文 / 英文
  const cnRatio = chineseRatio(trimmed)
  const enRatio = englishWordRatio(trimmed)

  if (cnRatio > 0.3) {
    results.push({ type: 'chinese', label: '中文', confidence: cnRatio })
  }
  if (enRatio > 0.4) {
    results.push({ type: 'english', label: '英文', confidence: enRatio })
  }

  // 兜底
  if (results.length === 0) {
    results.push({ type: 'general', label: '文本', confidence: 1 })
  }

  // 按置信度排序
  results.sort((a, b) => b.confidence - a.confidence)
  return results
}

export interface RecommendedAction {
  id: string
  label: string
  icon: string   // lucide icon name hint
  color: string  // tailwind color class
  prompt: string
}

/** 按内容类型推荐操作 */
const ACTION_MAP: Record<ContentType, RecommendedAction[]> = {
  url: [
    { id: 'open_url', label: '打开链接', icon: 'ExternalLink', color: 'text-blue-400', prompt: '' },
    { id: 'summarize_url', label: '总结网页', icon: 'FileText', color: 'text-purple-400', prompt: '请访问以下链接并总结其主要内容：\n\n' },
  ],
  json: [
    { id: 'format_json', label: '格式化', icon: 'Braces', color: 'text-yellow-400', prompt: '请格式化以下 JSON，使其更易读：\n\n' },
    { id: 'explain_json', label: '解释结构', icon: 'BookOpen', color: 'text-green-400', prompt: '请用中文解释以下 JSON 数据的结构和含义：\n\n' },
  ],
  code: [
    { id: 'explain_code', label: '解释代码', icon: 'BookOpen', color: 'text-green-400', prompt: '请用中文逐行解释以下代码的功能：\n\n```\n' },
    { id: 'optimize_code', label: '优化代码', icon: 'Sparkles', color: 'text-yellow-400', prompt: '请优化以下代码，提高可读性和性能，只返回优化后的代码：\n\n```\n' },
    { id: 'find_bugs', label: '查找问题', icon: 'Bug', color: 'text-red-400', prompt: '请检查以下代码中的潜在 bug 和问题：\n\n```\n' },
  ],
  english: [
    { id: 'translate_en', label: '翻译为中文', icon: 'Languages', color: 'text-blue-400', prompt: '请将以下英文翻译为中文，只返回翻译结果：\n\n' },
    { id: 'polish', label: '润色', icon: 'Sparkles', color: 'text-yellow-400', prompt: '请润色以下英文文本，使其更加地道：\n\n' },
  ],
  chinese: [
    { id: 'translate_cn', label: '翻译为英文', icon: 'Languages', color: 'text-blue-400', prompt: '请将以下中文翻译为地道的英文，只返回翻译结果：\n\n' },
    { id: 'polish_cn', label: 'AI 润色', icon: 'Sparkles', color: 'text-yellow-400', prompt: '请润色以下中文文本，使其更加通顺、专业：\n\n' },
    { id: 'summarize', label: '总结', icon: 'MessageSquare', color: 'text-purple-400', prompt: '请用3-5个要点总结以下内容：\n\n' },
  ],
  file_path: [
    { id: 'read_file', label: '读取文件', icon: 'FileText', color: 'text-cyan-400', prompt: '' },
    { id: 'open_folder', label: '打开目录', icon: 'FolderOpen', color: 'text-orange-400', prompt: '' },
  ],
  timestamp: [
    { id: 'convert_ts', label: '转换时间', icon: 'Clock', color: 'text-teal-400', prompt: '请将以下 Unix 时间戳转换为人类可读的日期时间格式（包含时区信息）：\n\n' },
  ],
  email: [
    { id: 'compose', label: '写邮件', icon: 'Mail', color: 'text-blue-400', prompt: '请帮我写一封发给以下邮箱地址的邮件，主题是（请帮我拟定一个合适的主题）：\n收件人：' },
  ],
  number: [
    { id: 'explain_num', label: '解释数字', icon: 'Hash', color: 'text-indigo-400', prompt: '请解释以下数字可能代表的含义（如金额、大小、距离等），并给出单位换算：\n\n' },
  ],
  general: [
    { id: 'translate', label: '翻译', icon: 'Languages', color: 'text-blue-400', prompt: '请将以下文本翻译为中文（如果是中文则翻译为英文），只返回翻译结果：\n\n' },
    { id: 'explain', label: '解释', icon: 'BookOpen', color: 'text-green-400', prompt: '请用简洁的中文解释以下内容：\n\n' },
    { id: 'summarize', label: '总结', icon: 'MessageSquare', color: 'text-purple-400', prompt: '请用3-5个要点总结以下内容：\n\n' },
  ],
}

/** 通用兜底操作（始终追加） */
const COMMON_ACTIONS: RecommendedAction[] = [
  { id: 'ask_ai', label: '问 AI', icon: 'MessageCircle', color: 'text-indigo-400', prompt: '' },
  { id: 'copy', label: '复制', icon: 'Copy', color: 'text-gray-400', prompt: '' },
]

/**
 * 根据文本内容推荐操作列表
 */
export function getRecommendedActions(text: string): {
  detections: DetectionResult[]
  actions: RecommendedAction[]
} {
  const detections = detectContent(text)
  const primaryType = detections[0]?.type ?? 'general'
  const actions = [...(ACTION_MAP[primaryType] || ACTION_MAP.general), ...COMMON_ACTIONS]
  return { detections, actions }
}
