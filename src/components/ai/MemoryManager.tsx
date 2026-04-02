import { useEffect, useState } from 'react';
import { useAgentMemoryStore } from '@/store/agent-memory-store';
import { Brain, Trash2, Plus, Search } from 'lucide-react';

export function MemoryManager({ compact = false }: { compact?: boolean }) {
  const { memories, loaded, load, addMemory, removeMemory } = useAgentMemoryStore();
  const [searchQuery, setSearchQuery] = useState('');
  const [showAddForm, setShowAddForm] = useState(false);
  const [newMemory, setNewMemory] = useState({
    content: '',
    type: 'fact' as 'preference' | 'fact' | 'goal' | 'constraint' | 'context',
    scope: 'workspace' as 'global' | 'workspace' | 'conversation'
  });

  useEffect(() => {
    if (!loaded) void load();
  }, [loaded, load]);

  const filteredMemories = memories.filter(m =>
    m.content.toLowerCase().includes(searchQuery.toLowerCase())
  );

  const handleAdd = async () => {
    if (!newMemory.content.trim()) return;
    await addMemory(newMemory);
    setNewMemory({ content: '', type: 'fact', scope: 'workspace' });
    setShowAddForm(false);
  };

  return (
    <div className={compact ? 'space-y-2' : 'space-y-3'}>
      <div className="flex items-center justify-between">
        <div>
          <span className={`font-semibold ${compact ? 'text-xs' : 'text-sm'}`}>
            AI 记忆
          </span>
          <span className="ml-2 text-[10px] text-[var(--color-text-secondary)]">
            {memories.length} 条记录
          </span>
        </div>
        <button
          onClick={() => setShowAddForm(!showAddForm)}
          className="p-1.5 rounded hover:bg-[var(--color-bg-hover)] text-[var(--color-text-secondary)]"
        >
          <Plus className="w-4 h-4" />
        </button>
      </div>

      {showAddForm && (
        <div className="border border-[var(--color-border)] rounded-lg p-3 bg-[var(--color-bg-secondary)] space-y-2">
          <textarea
            value={newMemory.content}
            onChange={e => setNewMemory({ ...newMemory, content: e.target.value })}
            placeholder="输入记忆内容..."
            className="w-full p-2 text-xs rounded border border-[var(--color-border)] bg-[var(--color-bg)] resize-none"
            rows={3}
          />
          <div className="flex gap-2">
            <select
              value={newMemory.type}
              onChange={e => setNewMemory({ ...newMemory, type: e.target.value as any })}
              className="text-xs p-1.5 rounded border border-[var(--color-border)] bg-[var(--color-bg)]"
            >
              <option value="preference">偏好</option>
              <option value="fact">事实</option>
              <option value="goal">目标</option>
              <option value="constraint">约束</option>
              <option value="context">上下文</option>
            </select>
            <select
              value={newMemory.scope}
              onChange={e => setNewMemory({ ...newMemory, scope: e.target.value as any })}
              className="text-xs p-1.5 rounded border border-[var(--color-border)] bg-[var(--color-bg)]"
            >
              <option value="global">全局</option>
              <option value="workspace">工作区</option>
              <option value="conversation">对话</option>
            </select>
            <button
              onClick={handleAdd}
              className="px-3 py-1.5 text-xs rounded bg-[var(--color-accent)] text-white hover:opacity-90"
            >
              添加
            </button>
          </div>
        </div>
      )}

      <div className="relative">
        <Search className="absolute left-2 top-2 w-3.5 h-3.5 text-[var(--color-text-secondary)]" />
        <input
          type="text"
          value={searchQuery}
          onChange={e => setSearchQuery(e.target.value)}
          placeholder="搜索记忆..."
          className="w-full pl-8 pr-3 py-1.5 text-xs rounded border border-[var(--color-border)] bg-[var(--color-bg)]"
        />
      </div>

      <div className="space-y-2 max-h-96 overflow-y-auto">
        {filteredMemories.map(memory => (
          <div
            key={memory.id}
            className="border border-[var(--color-border)] rounded-lg p-2.5 bg-[var(--color-bg-secondary)]"
          >
            <div className="flex items-start justify-between gap-2">
              <div className="flex-1">
                <div className="flex items-center gap-2 mb-1">
                  <Brain className="w-3.5 h-3.5 text-[var(--color-text-secondary)]" />
                  <span className="text-[10px] px-1.5 py-0.5 rounded bg-[var(--color-bg)] text-[var(--color-text-secondary)]">
                    {memory.type}
                  </span>
                  <span className="text-[10px] text-[var(--color-text-secondary)]">
                    {memory.scope}
                  </span>
                </div>
                <p className="text-xs text-[var(--color-text)]">{memory.content}</p>
              </div>
              <button
                onClick={() => removeMemory(memory.id)}
                className="p-1 rounded hover:bg-red-500/20 text-red-500"
              >
                <Trash2 className="w-3.5 h-3.5" />
              </button>
            </div>
          </div>
        ))}

        {filteredMemories.length === 0 && (
          <div className="text-center py-8 text-[var(--color-text-secondary)] text-sm">
            {searchQuery ? '未找到匹配的记忆' : '暂无记忆记录'}
          </div>
        )}
      </div>
    </div>
  );
}
