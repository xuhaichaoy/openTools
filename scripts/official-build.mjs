import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'
import { spawnSync } from 'node:child_process'

const root = path.resolve(process.cwd(), 'official-plugins')
const distDir = path.join(root, 'dist')

if (!fs.existsSync(root)) {
  console.error('official-plugins 目录不存在')
  process.exit(1)
}

fs.rmSync(distDir, { recursive: true, force: true })
fs.mkdirSync(distDir, { recursive: true })

const pluginDirs = fs
  .readdirSync(root, { withFileTypes: true })
  .filter((entry) => entry.isDirectory() && entry.name !== 'dist')
  .map((entry) => entry.name)
  .sort()

const releases = []

for (const slug of pluginDirs) {
  const pluginDir = path.join(root, slug)
  const manifestPath = path.join(pluginDir, 'plugin.json')
  if (!fs.existsSync(manifestPath)) {
    console.warn(`[skip] ${slug}: 缺少 plugin.json`)
    continue
  }

  const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'))
  const version = String(manifest.version || '1.0.0')
  const zipName = `${slug}-${version}.zip`
  const zipPath = path.join(distDir, zipName)

  const zipResult = spawnSync('zip', ['-qr', zipPath, '.', '-x', '*.DS_Store'], {
    cwd: pluginDir,
    stdio: 'inherit',
  })
  if (zipResult.status !== 0) {
    console.error(`打包失败: ${slug}`)
    process.exit(zipResult.status ?? 1)
  }

  const zipBytes = fs.readFileSync(zipPath)
  const sha256 = crypto.createHash('sha256').update(zipBytes).digest('hex')

  releases.push({
    slug,
    name: String(manifest.pluginName || slug),
    version,
    zipName,
    packageSizeBytes: zipBytes.length,
    packageSha256: sha256,
    packageFilePath: `plugins/official/${slug}/${version}.zip`,
  })
}

const manifestOutput = {
  generatedAt: new Date().toISOString(),
  count: releases.length,
  releases,
}
fs.writeFileSync(
  path.join(distDir, 'release-manifest.json'),
  `${JSON.stringify(manifestOutput, null, 2)}\n`,
  'utf8',
)

console.log(`官方插件构建完成: ${releases.length} 个包`) 
console.log(`产物目录: ${distDir}`)
