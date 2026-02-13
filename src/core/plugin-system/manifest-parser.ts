import type { PluginManifest, PluginFeature } from './types'

/**
 * 解析 uTools plugin.json 格式
 */
function parseUtoolsManifest(raw: Record<string, unknown>): PluginManifest {
  return {
    pluginName: (raw.pluginName as string) || (raw.name as string) || '未命名插件',
    description: (raw.description as string) || '',
    version: (raw.version as string) || '0.0.0',
    author: raw.author as string | undefined,
    homepage: raw.homepage as string | undefined,
    logo: raw.logo as string | undefined,
    main: raw.main as string | undefined,
    preload: raw.preload as string | undefined,
    features: (raw.features as PluginFeature[]) || [],
    pluginType: (raw.pluginType as 'ui' | 'system') || 'ui',
    development: raw.development as PluginManifest['development'],
  }
}

/**
 * 解析 Rubick package.json 格式 (超集，字段对应关系略有不同)
 */
function parseRubickManifest(raw: Record<string, unknown>): PluginManifest {
  const rubick = raw as Record<string, unknown>
  return {
    pluginName: (rubick.pluginName as string) || (rubick.name as string) || '未命名插件',
    description: (rubick.description as string) || '',
    version: (rubick.version as string) || '0.0.0',
    author: rubick.author as string | undefined,
    homepage: rubick.homepage as string | undefined,
    logo: rubick.logo as string | undefined,
    main: rubick.main as string | undefined,
    preload: rubick.preload as string | undefined,
    features: (rubick.features as PluginFeature[]) || [],
    pluginType: 'ui',
    development: rubick.development as PluginManifest['development'],
  }
}

/**
 * 自动检测格式并解析 manifest
 * - 文件名为 plugin.json → uTools 格式
 * - 文件名为 package.json → Rubick 格式
 */
export function parseManifest(
  raw: Record<string, unknown>,
  filename: string
): PluginManifest {
  if (filename === 'plugin.json') {
    return parseUtoolsManifest(raw)
  }
  return parseRubickManifest(raw)
}

/**
 * 验证 manifest 是否有效
 */
export function validateManifest(manifest: PluginManifest): { valid: boolean; errors: string[] } {
  const errors: string[] = []

  if (!manifest.pluginName) {
    errors.push('缺少 pluginName')
  }
  if (!manifest.features || manifest.features.length === 0) {
    errors.push('至少需要一个 feature')
  }
  for (const feature of manifest.features) {
    if (!feature.code) {
      errors.push(`Feature 缺少 code`)
    }
    if (!feature.cmds || feature.cmds.length === 0) {
      errors.push(`Feature "${feature.code}" 缺少 cmds`)
    }
  }

  return { valid: errors.length === 0, errors }
}
