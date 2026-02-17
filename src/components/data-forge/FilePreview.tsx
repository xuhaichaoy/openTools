import { useState, useEffect } from 'react'
import { FileSpreadsheet, FileText, FileJson, X, Download, Eye, ExternalLink, Table } from 'lucide-react'
import { handleError } from '@/core/errors'
import { invoke } from '@tauri-apps/api/core'

interface FilePreviewProps {
  filePath: string
  onClose: () => void
}

interface CSVData {
  headers: string[]
  rows: string[][]
  totalRows: number
}

export function FilePreview({ filePath, onClose }: FilePreviewProps) {
  const [content, setContent] = useState<string>('')
  const [csvData, setCsvData] = useState<CSVData | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  const fileName = filePath.split('/').pop() || filePath
  const ext = fileName.split('.').pop()?.toLowerCase() || ''

  useEffect(() => {
    loadFile()
  }, [filePath])

  const loadFile = async () => {
    setLoading(true)
    setError(null)
    try {
      // 读取文件前 100KB 用于预览
      const text = await invoke<string>('preview_file', { filePath, maxBytes: 102400 })

      if (ext === 'csv') {
        parseCSV(text)
      } else {
        setContent(text)
      }
    } catch (e) {
      setError(`无法预览文件: ${e}`)
    }
    setLoading(false)
  }

  const parseCSV = (text: string) => {
    const lines = text.split('\n').filter((l) => l.trim())
    if (lines.length === 0) {
      setCsvData({ headers: [], rows: [], totalRows: 0 })
      return
    }

    const headers = lines[0].split(',').map((h) => h.trim().replace(/^"|"$/g, ''))
    const rows = lines.slice(1, 51).map((line) =>
      line.split(',').map((cell) => cell.trim().replace(/^"|"$/g, '')),
    )

    setCsvData({
      headers,
      rows,
      totalRows: lines.length - 1,
    })
  }

  const handleOpenInExplorer = async () => {
    try {
      await invoke('open_file_location', { filePath })
    } catch (e) {
      handleError(e, { context: '打开文件位置' })
    }
  }

  const getFileIcon = () => {
    switch (ext) {
      case 'xlsx':
      case 'xls':
        return <FileSpreadsheet className="w-4 h-4 text-green-400" />
      case 'csv':
        return <Table className="w-4 h-4 text-blue-400" />
      case 'json':
        return <FileJson className="w-4 h-4 text-yellow-400" />
      default:
        return <FileText className="w-4 h-4 text-gray-400" />
    }
  }

  return (
    <div className="bg-[var(--color-bg)] rounded-xl border border-[var(--color-border)] shadow-2xl overflow-hidden flex flex-col max-h-[400px]">
      {/* 头部 */}
      <div className="flex items-center justify-between px-4 py-2 border-b border-[var(--color-border)] bg-[var(--color-bg-secondary)]">
        <div className="flex items-center gap-2 min-w-0">
          {getFileIcon()}
          <span className="text-xs font-medium text-[var(--color-text)] truncate">{fileName}</span>
          {csvData && (
            <span className="text-[10px] text-[var(--color-text-secondary)]">
              {csvData.totalRows} 行 × {csvData.headers.length} 列
            </span>
          )}
        </div>
        <div className="flex items-center gap-1">
          <button
            onClick={handleOpenInExplorer}
            className="p-1.5 rounded hover:bg-[var(--color-bg-hover)] text-[var(--color-text-secondary)] hover:text-[var(--color-text)] transition-colors"
            title="在文件管理器中打开"
          >
            <ExternalLink className="w-3.5 h-3.5" />
          </button>
          <button
            onClick={onClose}
            className="p-1.5 rounded hover:bg-[var(--color-bg-hover)] text-[var(--color-text-secondary)] hover:text-[var(--color-text)] transition-colors"
          >
            <X className="w-3.5 h-3.5" />
          </button>
        </div>
      </div>

      {/* 内容区 */}
      <div className="flex-1 overflow-auto">
        {loading && (
          <div className="text-center py-8 text-[var(--color-text-secondary)]">
            <Eye className="w-6 h-6 mx-auto mb-2 animate-pulse" />
            <span className="text-xs">加载中...</span>
          </div>
        )}

        {error && (
          <div className="text-center py-8 text-red-400">
            <span className="text-xs">{error}</span>
          </div>
        )}

        {/* CSV 表格预览 */}
        {!loading && !error && csvData && (
          <div className="overflow-auto">
            <table className="w-full text-[11px] border-collapse">
              <thead>
                <tr className="bg-[var(--color-bg-secondary)] sticky top-0">
                  <th className="px-2 py-1.5 text-left text-[var(--color-text-secondary)] font-medium border-b border-[var(--color-border)] w-8">
                    #
                  </th>
                  {csvData.headers.map((h, i) => (
                    <th
                      key={i}
                      className="px-2 py-1.5 text-left text-[var(--color-text-secondary)] font-medium border-b border-[var(--color-border)] whitespace-nowrap"
                    >
                      {h}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {csvData.rows.map((row, i) => (
                  <tr key={i} className="hover:bg-[var(--color-bg-hover)]">
                    <td className="px-2 py-1 text-[var(--color-text-secondary)] border-b border-[var(--color-border)] opacity-50">
                      {i + 1}
                    </td>
                    {row.map((cell, j) => (
                      <td
                        key={j}
                        className="px-2 py-1 text-[var(--color-text)] border-b border-[var(--color-border)] whitespace-nowrap max-w-[200px] truncate"
                      >
                        {cell}
                      </td>
                    ))}
                  </tr>
                ))}
              </tbody>
            </table>
            {csvData.totalRows > 50 && (
              <div className="text-center py-2 text-[10px] text-[var(--color-text-secondary)]">
                仅显示前 50 行，共 {csvData.totalRows} 行
              </div>
            )}
          </div>
        )}

        {/* 文本预览 */}
        {!loading && !error && !csvData && content && (
          <pre className="p-3 text-[11px] text-[var(--color-text)] font-mono whitespace-pre-wrap break-all leading-relaxed">
            {content}
          </pre>
        )}
      </div>
    </div>
  )
}
