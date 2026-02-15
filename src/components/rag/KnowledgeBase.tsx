import { useState, useEffect } from 'react'
import { ArrowLeft, Upload, Trash2, RefreshCw, Search, BookOpen, HardDrive, FileText, AlertCircle, CheckCircle, Loader2 } from 'lucide-react'
import { useRAGStore } from '@/store/rag-store'
import { open } from '@tauri-apps/plugin-dialog'
import { useDragWindow } from '@/hooks/useDragWindow'

export function KnowledgeBase({ onBack }: { onBack?: () => void }) {
  const {
    docs, stats, isLoading, isIndexing,
    searchResults, searchQuery,
    loadDocs, loadStats, importDoc, removeDoc, reindexDoc,
    search, setSearchQuery,
  } = useRAGStore()

  const [activeTab, setActiveTab] = useState<'docs' | 'search'>('docs')

  useEffect(() => {
    loadDocs()
    loadStats()
  }, [])

  const handleImport = async () => {
    try {
      const selected = await open({
        multiple: true,
        filters: [
          { name: '文档', extensions: ['txt', 'md', 'json', 'csv', 'html'] },
        ],
      })
      if (selected) {
        const paths = Array.isArray(selected) ? selected : [selected]
        for (const filePath of paths) {
          if (filePath) {
            await importDoc(filePath)
          }
        }
      }
    } catch (e) {
      console.error('导入失败:', e)
    }
  }

  const handleSearch = async () => {
    if (!searchQuery.trim()) return
    await search(searchQuery.trim())
  }

  const formatSize = (bytes: number) => {
    if (bytes < 1024) return `${bytes} B`
    if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
    return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
  }

  const { onMouseDown } = useDragWindow()

  const getStatusIcon = (status: string) => {
    switch (status) {
      case 'indexed': return <CheckCircle className="w-3.5 h-3.5 text-green-400" />
      case 'processing': return <Loader2 className="w-3.5 h-3.5 text-yellow-400 animate-spin" />
      case 'error': return <AlertCircle className="w-3.5 h-3.5 text-red-400" />
      default: return <FileText className="w-3.5 h-3.5 text-gray-400" />
    }
  }

  return (
    <div className="bg-[var(--color-bg)] overflow-hidden flex flex-col h-full">
      {/* 顶部 */}
      <div className="flex items-center justify-between px-4 py-3 border-b border-[var(--color-border)] cursor-grab active:cursor-grabbing" onMouseDown={onMouseDown}>
        <div className="flex items-center gap-2">
          {onBack && (
            <>
              <button onClick={onBack} className="p-1 rounded hover:bg-[var(--color-bg-hover)] text-[var(--color-text-secondary)]">
                <ArrowLeft className="w-4 h-4" />
              </button>
              <BookOpen className="w-4 h-4 text-emerald-400" />
              <span className="text-sm font-medium text-[var(--color-text)]">知识库</span>
            </>
          )}
        </div>
        <button
          onClick={handleImport}
          disabled={isIndexing}
          className="flex items-center gap-1.5 text-xs px-3 py-1.5 bg-emerald-500 text-white rounded-lg hover:bg-emerald-600 disabled:opacity-40 transition-colors"
        >
          {isIndexing ? <Loader2 className="w-3 h-3 animate-spin" /> : <Upload className="w-3 h-3" />}
          导入文档
        </button>
      </div>

      {/* 统计栏 */}
      {stats && (
        <div className="flex items-center gap-4 px-4 py-2 bg-[var(--color-bg-secondary)] text-[10px] text-[var(--color-text-secondary)]">
          <span>{stats.totalDocs} 篇文档</span>
          <span>{stats.totalChunks} 个分块</span>
          <span>~{stats.totalTokens.toLocaleString()} tokens</span>
          <span><HardDrive className="w-3 h-3 inline mr-0.5" />{formatSize(stats.indexSize)}</span>
        </div>
      )}

      {/* Tab 切换 */}
      <div className="flex gap-1 px-4 pt-2">
        <button
          onClick={() => setActiveTab('docs')}
          className={`text-xs px-3 py-1.5 rounded-t-lg border-b-2 transition-colors ${
            activeTab === 'docs'
              ? 'border-emerald-400 text-emerald-400 bg-[var(--color-bg-secondary)]'
              : 'border-transparent text-[var(--color-text-secondary)] hover:text-[var(--color-text)]'
          }`}
        >
          文档管理
        </button>
        <button
          onClick={() => setActiveTab('search')}
          className={`text-xs px-3 py-1.5 rounded-t-lg border-b-2 transition-colors ${
            activeTab === 'search'
              ? 'border-emerald-400 text-emerald-400 bg-[var(--color-bg-secondary)]'
              : 'border-transparent text-[var(--color-text-secondary)] hover:text-[var(--color-text)]'
          }`}
        >
          检索测试
        </button>
      </div>
      <div className="h-px bg-[var(--color-border)]" />

      {/* 内容区 */}
      <div className="flex-1 overflow-y-auto p-4">
        {activeTab === 'docs' && (
          <div className="space-y-2">
            {isLoading && (
              <div className="text-center py-8 text-[var(--color-text-secondary)]">
                <Loader2 className="w-6 h-6 animate-spin mx-auto mb-2" />
                <span className="text-xs">加载中...</span>
              </div>
            )}

            {!isLoading && docs.length === 0 && (
              <div className="text-center py-8 text-[var(--color-text-secondary)]">
                <BookOpen className="w-10 h-10 mx-auto mb-3 opacity-30" />
                <p className="text-xs">暂无文档</p>
                <p className="text-[10px] mt-1">点击"导入文档"添加知识库内容</p>
              </div>
            )}

            {docs.map((doc) => (
              <div
                key={doc.id}
                className="flex items-center justify-between p-3 rounded-lg bg-[var(--color-bg-secondary)] border border-[var(--color-border)] hover:border-[var(--color-accent)] transition-colors"
              >
                <div className="flex items-center gap-3 flex-1 min-w-0">
                  {getStatusIcon(doc.status)}
                  <div className="min-w-0 flex-1">
                    <div className="text-xs font-medium text-[var(--color-text)] truncate">{doc.name}</div>
                    <div className="text-[10px] text-[var(--color-text-secondary)] flex items-center gap-2 mt-0.5">
                      <span>{doc.chunkCount} 块</span>
                      <span>~{doc.tokenCount} tokens</span>
                      <span>{formatSize(doc.size)}</span>
                      {doc.tags && doc.tags.length > 0 && (
                        <span className="text-emerald-400">{doc.tags.join(', ')}</span>
                      )}
                    </div>
                    {doc.errorMsg && (
                      <div className="text-[10px] text-red-400 mt-0.5 truncate">{doc.errorMsg}</div>
                    )}
                  </div>
                </div>
                <div className="flex items-center gap-1 ml-2">
                  <button
                    onClick={() => reindexDoc(doc.id)}
                    disabled={isIndexing}
                    className="p-1.5 rounded hover:bg-[var(--color-bg-hover)] text-[var(--color-text-secondary)] hover:text-[var(--color-text)] transition-colors"
                    title="重建索引"
                  >
                    <RefreshCw className="w-3.5 h-3.5" />
                  </button>
                  <button
                    onClick={() => removeDoc(doc.id)}
                    className="p-1.5 rounded hover:bg-red-500/10 text-[var(--color-text-secondary)] hover:text-red-400 transition-colors"
                    title="删除"
                  >
                    <Trash2 className="w-3.5 h-3.5" />
                  </button>
                </div>
              </div>
            ))}
          </div>
        )}

        {activeTab === 'search' && (
          <div className="space-y-3">
            <div className="flex gap-2">
              <input
                type="text"
                className="flex-1 bg-[var(--color-bg-secondary)] text-[var(--color-text)] text-xs rounded-lg px-3 py-2 outline-none border border-[var(--color-border)] focus:border-emerald-400"
                placeholder="输入检索内容..."
                value={searchQuery}
                onChange={(e) => setSearchQuery(e.target.value)}
                onKeyDown={(e) => e.key === 'Enter' && handleSearch()}
              />
              <button
                onClick={handleSearch}
                disabled={!searchQuery.trim()}
                className="px-3 py-2 text-xs rounded-lg bg-emerald-500 text-white hover:bg-emerald-600 disabled:opacity-40 transition-colors flex items-center gap-1"
              >
                <Search className="w-3 h-3" />
                检索
              </button>
            </div>

            {searchResults.length > 0 && (
              <div className="space-y-2">
                <div className="text-[10px] text-[var(--color-text-secondary)]">
                  找到 {searchResults.length} 个相关片段
                </div>
                {searchResults.map((result, i) => (
                  <div key={i} className="p-3 rounded-lg bg-[var(--color-bg-secondary)] border border-[var(--color-border)]">
                    <div className="flex items-center justify-between mb-1.5">
                      <span className="text-[10px] text-emerald-400 font-medium">
                        {result.chunk.metadata.source}
                      </span>
                      <span className="text-[10px] text-[var(--color-text-secondary)]">
                        相似度: {(result.score * 100).toFixed(1)}%
                      </span>
                    </div>
                    <p className="text-xs text-[var(--color-text)] leading-relaxed whitespace-pre-wrap">
                      {result.chunk.content.length > 300
                        ? result.chunk.content.slice(0, 300) + '...'
                        : result.chunk.content}
                    </p>
                  </div>
                ))}
              </div>
            )}

            {searchResults.length === 0 && searchQuery && (
              <div className="text-center py-6 text-[var(--color-text-secondary)]">
                <Search className="w-8 h-8 mx-auto mb-2 opacity-30" />
                <p className="text-xs">输入关键词后点击检索</p>
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  )
}
