import { Search, Folder, FolderOpen, FileCode, Star, Clock } from 'lucide-react'
import { useDataForgeStore } from '@/store/data-forge-store'

export function ScriptBrowser() {
  const {
    categories,
    selectedCategory,
    setSelectedCategory,
    searchQuery,
    setSearchQuery,
    getFilteredScripts,
    setSelectedScript,
    isLoading,
  } = useDataForgeStore()

  const filteredScripts = getFilteredScripts()

  return (
    <div className="flex flex-col h-full">
      {/* 搜索 */}
      <div className="p-2">
        <div className="flex items-center gap-1.5 px-2 py-1.5 bg-[var(--color-bg-secondary)] rounded-lg">
          <Search className="w-3.5 h-3.5 text-[var(--color-text-secondary)]" />
          <input
            className="flex-1 bg-transparent text-xs text-[var(--color-text)] outline-none placeholder:text-[var(--color-text-secondary)]"
            placeholder="搜索脚本..."
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
          />
        </div>
      </div>

      {/* 分类列表 */}
      <div className="flex-1 overflow-y-auto px-1">
        {/* 全部 */}
        <button
          className={`w-full flex items-center gap-2 px-3 py-1.5 text-xs rounded-lg transition-colors ${
            selectedCategory === null
              ? 'bg-[var(--color-bg-hover)] text-[var(--color-text)]'
              : 'text-[var(--color-text-secondary)] hover:bg-[var(--color-bg-hover)] hover:text-[var(--color-text)]'
          }`}
          onClick={() => setSelectedCategory(null)}
        >
          <Folder className="w-3.5 h-3.5" />
          <span className="flex-1 text-left">全部</span>
          <span className="text-[10px] opacity-60">{categories.reduce((s, c) => s + c.count, 0)}</span>
        </button>

        {/* 分类 */}
        {categories.map((cat) => (
          <button
            key={cat.name}
            className={`w-full flex items-center gap-2 px-3 py-1.5 text-xs rounded-lg transition-colors ${
              selectedCategory === cat.name
                ? 'bg-[var(--color-bg-hover)] text-[var(--color-text)]'
                : 'text-[var(--color-text-secondary)] hover:bg-[var(--color-bg-hover)] hover:text-[var(--color-text)]'
            }`}
            onClick={() => setSelectedCategory(cat.name)}
          >
            {selectedCategory === cat.name ? (
              <FolderOpen className="w-3.5 h-3.5 text-purple-400" />
            ) : (
              <Folder className="w-3.5 h-3.5" />
            )}
            <span className="flex-1 text-left truncate">{cat.name}</span>
            <span className="text-[10px] opacity-60">{cat.count}</span>
          </button>
        ))}

        {/* 分隔线 */}
        <div className="my-2 border-t border-[var(--color-border)]" />

        {/* 最近执行 / 常用 */}
        <button
          className="w-full flex items-center gap-2 px-3 py-1.5 text-xs text-[var(--color-text-secondary)] hover:bg-[var(--color-bg-hover)] hover:text-[var(--color-text)] rounded-lg transition-colors"
          onClick={() => {
            setSelectedCategory(null)
            setSelectedScript(null)
          }}
        >
          <Clock className="w-3.5 h-3.5" />
          <span>最近执行</span>
        </button>
        <button
          className="w-full flex items-center gap-2 px-3 py-1.5 text-xs text-[var(--color-text-secondary)] hover:bg-[var(--color-bg-hover)] hover:text-[var(--color-text)] rounded-lg transition-colors"
        >
          <Star className="w-3.5 h-3.5" />
          <span>常用脚本</span>
        </button>
      </div>

      {/* 脚本列表（搜索模式或选中分类时显示） */}
      {(searchQuery || selectedCategory) && filteredScripts.length > 0 && (
        <div className="border-t border-[var(--color-border)] max-h-[200px] overflow-y-auto">
          {filteredScripts.map((script) => (
            <button
              key={script.id}
              className="w-full flex items-center gap-2 px-3 py-2 text-xs hover:bg-[var(--color-bg-hover)] transition-colors"
              onClick={() => setSelectedScript(script)}
            >
              <FileCode className="w-3.5 h-3.5 text-purple-400 shrink-0" />
              <div className="flex-1 min-w-0 text-left">
                <div className="text-[var(--color-text)] truncate">{script.name}</div>
                <div className="text-[10px] text-[var(--color-text-secondary)] truncate">{script.description}</div>
              </div>
            </button>
          ))}
        </div>
      )}

      {isLoading && (
        <div className="px-3 py-2 text-xs text-[var(--color-text-secondary)] text-center">
          加载中...
        </div>
      )}
    </div>
  )
}
