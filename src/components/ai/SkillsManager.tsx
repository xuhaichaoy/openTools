/**
 * SkillsManager - 独立的技能管理组件
 *
 * 可嵌入 Settings、Agent Workbench、AI Center 弹出面板等任意位置。
 * 支持查看、启用/禁用、固定、创建、编辑、删除技能。
 */

import React, { useEffect, useState, useCallback, useRef } from "react";
import { useSkillStore } from "@/store/skill-store";
import type { AgentSkill, AgentSkillInput } from "@/core/agent/skills/types";
import { save } from "@tauri-apps/plugin-dialog";
import { writeTextFile } from "@tauri-apps/plugin-fs";

// ── 主面板 ──

export function SkillsManager({ compact = false }: { compact?: boolean }) {
  const { skills, loaded, load, toggleEnabled, toggleManualActive, manualActiveIds, add, update, remove } =
    useSkillStore();
  const [showForm, setShowForm] = useState(false);
  const [editingSkill, setEditingSkill] = useState<AgentSkill | null>(null);

  useEffect(() => {
    if (!loaded) void load();
  }, [loaded, load]);

  const builtinSkills = skills.filter((s) => s.source === "builtin");
  const userSkills = skills.filter((s) => s.source === "user");

  const handleCreate = useCallback(() => {
    setEditingSkill(null);
    setShowForm(true);
  }, []);

  const handleEdit = useCallback((skill: AgentSkill) => {
    setEditingSkill(skill);
    setShowForm(true);
  }, []);

  const handleFormDone = useCallback(() => {
    setShowForm(false);
    setEditingSkill(null);
  }, []);

  const fileInputRef = useRef<HTMLInputElement>(null);
  const [importMsg, setImportMsg] = useState("");

  const handleImport = useCallback(async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    try {
      const text = await file.text();
      const data = JSON.parse(text);
      const items: AgentSkillInput[] = Array.isArray(data) ? data : [data];
      let count = 0;
      for (const item of items) {
        if (!item.name || !item.systemPrompt) continue;
        await add({
          name: item.name,
          description: item.description ?? "",
          version: item.version ?? "1.0.0",
          enabled: item.enabled ?? true,
          autoActivate: item.autoActivate ?? (!!item.triggerPatterns?.length),
          triggerPatterns: item.triggerPatterns,
          systemPrompt: item.systemPrompt,
          toolFilter: item.toolFilter,
          category: item.category,
          tags: item.tags,
          icon: item.icon,
          source: "user",
        });
        count++;
      }
      setImportMsg(`已导入 ${count} 个技能`);
      setTimeout(() => setImportMsg(""), 3000);
    } catch (err) {
      setImportMsg(`导入失败: ${err instanceof Error ? err.message : "格式错误"}`);
      setTimeout(() => setImportMsg(""), 4000);
    }
    if (fileInputRef.current) fileInputRef.current.value = "";
  }, [add]);

  const handleExport = useCallback(async (skill: AgentSkill) => {
    const exportData = {
      name: skill.name,
      description: skill.description,
      version: skill.version,
      author: skill.author,
      enabled: true,
      autoActivate: skill.autoActivate,
      triggerPatterns: skill.triggerPatterns,
      systemPrompt: skill.systemPrompt,
      toolFilter: skill.toolFilter,
      category: skill.category,
      tags: skill.tags,
      icon: skill.icon,
    };
    try {
      const path = await save({
        defaultPath: `${skill.name.replace(/\s+/g, "-")}.skill.json`,
        filters: [{ name: "Skill JSON", extensions: ["json"] }],
      });
      if (path) {
        await writeTextFile(path, JSON.stringify(exportData, null, 2));
      }
    } catch { /* user cancelled */ }
  }, []);

  const handleExportAll = useCallback(async () => {
    const exportSkills = skills.filter((s) => s.source === "user");
    if (exportSkills.length === 0) return;
    const exportData = exportSkills.map((s) => ({
      name: s.name,
      description: s.description,
      version: s.version,
      author: s.author,
      enabled: true,
      autoActivate: s.autoActivate,
      triggerPatterns: s.triggerPatterns,
      systemPrompt: s.systemPrompt,
      toolFilter: s.toolFilter,
      category: s.category,
      tags: s.tags,
      icon: s.icon,
    }));
    try {
      const path = await save({
        defaultPath: "my-skills.json",
        filters: [{ name: "Skills JSON", extensions: ["json"] }],
      });
      if (path) {
        await writeTextFile(path, JSON.stringify(exportData, null, 2));
      }
    } catch { /* user cancelled */ }
  }, [skills]);

  return (
    <div className={compact ? "space-y-2" : "space-y-3"}>
      <div className="flex items-center justify-between">
        <div>
          <span className={`font-semibold ${compact ? "text-xs" : "text-sm"}`}>
            领域技能
          </span>
          <span className="ml-2 text-[10px] text-[var(--color-text-secondary)]">
            {skills.filter((s) => s.enabled).length}/{skills.length} 已启用
          </span>
        </div>
        <div className="flex items-center gap-1">
          <input
            ref={fileInputRef}
            type="file"
            accept=".json"
            className="hidden"
            onChange={handleImport}
          />
          <button
            onClick={() => fileInputRef.current?.click()}
            className="px-2 py-0.5 text-[10px] rounded bg-[var(--color-bg-secondary)] text-[var(--color-text-secondary)] hover:text-[var(--color-text)] transition-colors"
            title="从 JSON 文件导入技能"
          >
            导入
          </button>
          {userSkills.length > 0 && (
            <button
              onClick={handleExportAll}
              className="px-2 py-0.5 text-[10px] rounded bg-[var(--color-bg-secondary)] text-[var(--color-text-secondary)] hover:text-[var(--color-text)] transition-colors"
              title="导出所有自定义技能"
            >
              导出
            </button>
          )}
          <button
            onClick={showForm ? handleFormDone : handleCreate}
            className={`px-2 py-0.5 text-[10px] rounded transition-colors ${
              showForm
                ? "bg-[var(--color-bg-secondary)] text-[var(--color-text-secondary)]"
                : "bg-blue-500/15 text-blue-500 hover:bg-blue-500/25"
            }`}
          >
            {showForm ? "取消" : "新建"}
          </button>
        </div>
      </div>

      {importMsg && (
        <div className={`text-[10px] px-2 py-1 rounded ${importMsg.includes("失败") ? "bg-red-500/10 text-red-500" : "bg-emerald-500/10 text-emerald-500"}`}>
          {importMsg}
        </div>
      )}

      <p className="text-[10px] text-[var(--color-text-secondary)] leading-relaxed">
        技能根据输入内容自动激活，为 AI 注入领域知识和行为约束。适用于 Ask / Agent / Cluster 三个模式。
        支持导入 <code className="text-[9px]">.skill.json</code> 文件安装技能。
      </p>

      {showForm && (
        <SkillForm
          editing={editingSkill}
          onSave={async (input) => {
            if (editingSkill) {
              await update(editingSkill.id, input as Partial<AgentSkill>);
            } else {
              await add(input as AgentSkillInput);
            }
            handleFormDone();
          }}
          onCancel={handleFormDone}
        />
      )}

      {builtinSkills.length > 0 && (
        <SkillGroup
          label="内置技能"
          skills={builtinSkills}
          manualActiveIds={manualActiveIds}
          onToggleEnabled={toggleEnabled}
          onTogglePin={toggleManualActive}
          compact={compact}
        />
      )}

      {userSkills.length > 0 && (
        <SkillGroup
          label="自定义技能"
          skills={userSkills}
          manualActiveIds={manualActiveIds}
          onToggleEnabled={toggleEnabled}
          onTogglePin={toggleManualActive}
          onEdit={handleEdit}
          onExport={handleExport}
          onRemove={(id) => {
            if (window.confirm("确定要删除这个技能吗？此操作不可撤销。")) {
              void remove(id);
            }
          }}
          compact={compact}
        />
      )}

      {!loaded && (
        <div className="text-[10px] text-[var(--color-text-secondary)]">
          加载中...
        </div>
      )}
    </div>
  );
}

// ── 技能分组 ──

function SkillGroup({
  label,
  skills,
  manualActiveIds,
  onToggleEnabled,
  onTogglePin,
  onEdit,
  onExport,
  onRemove,
  compact,
}: {
  label: string;
  skills: AgentSkill[];
  manualActiveIds: Set<string>;
  onToggleEnabled: (id: string) => void;
  onTogglePin: (id: string) => void;
  onEdit?: (skill: AgentSkill) => void;
  onExport?: (skill: AgentSkill) => void;
  onRemove?: (id: string) => void;
  compact?: boolean;
}) {
  return (
    <div className="space-y-1">
      <span className="text-[10px] text-[var(--color-text-secondary)] font-medium">
        {label}
      </span>
      {skills.map((skill) => (
        <SkillCard
          key={skill.id}
          skill={skill}
          isPinned={manualActiveIds.has(skill.id)}
          onToggleEnabled={() => onToggleEnabled(skill.id)}
          onTogglePin={() => onTogglePin(skill.id)}
          onEdit={onEdit ? () => onEdit(skill) : undefined}
          onExport={onExport ? () => onExport(skill) : undefined}
          onRemove={onRemove ? () => onRemove(skill.id) : undefined}
          compact={compact}
        />
      ))}
    </div>
  );
}

// ── 单个技能卡片 ──

function SkillCard({
  skill,
  isPinned,
  onToggleEnabled,
  onTogglePin,
  onEdit,
  onExport,
  onRemove,
  compact,
}: {
  skill: AgentSkill;
  isPinned: boolean;
  onToggleEnabled: () => void;
  onTogglePin: () => void;
  onEdit?: () => void;
  onExport?: () => void;
  onRemove?: () => void;
  compact?: boolean;
}) {
  const [expanded, setExpanded] = useState(false);

  return (
    <div
      className={`rounded border border-[var(--color-border)] bg-[var(--color-bg)] transition-colors ${
        compact ? "px-2 py-1" : "px-2.5 py-1.5"
      } ${!skill.enabled ? "opacity-60" : ""}`}
    >
      <div className="flex items-center gap-1.5">
        {skill.icon && <span className="text-xs">{skill.icon}</span>}
        <span className="text-xs font-medium flex-1 truncate">{skill.name}</span>

        {skill.category && (
          <span className="text-[9px] px-1 py-px rounded bg-[var(--color-bg-secondary)] text-[var(--color-text-secondary)]">
            {skill.category}
          </span>
        )}

        <button
          onClick={onTogglePin}
          className={`px-1.5 py-0.5 text-[10px] rounded transition-colors ${
            isPinned
              ? "bg-blue-500/20 text-blue-500"
              : "text-[var(--color-text-secondary)] hover:bg-[var(--color-bg-secondary)]"
          }`}
          title={isPinned ? "取消固定（恢复自动激活）" : "固定（始终激活）"}
        >
          {isPinned ? "已固定" : "固定"}
        </button>

        <button
          onClick={onToggleEnabled}
          className={`px-1.5 py-0.5 text-[10px] rounded transition-colors ${
            skill.enabled
              ? "bg-emerald-500/15 text-emerald-500"
              : "bg-[var(--color-bg-secondary)] text-[var(--color-text-secondary)]"
          }`}
        >
          {skill.enabled ? "启用" : "禁用"}
        </button>

        {onEdit && (
          <button
            onClick={onEdit}
            className="px-1.5 py-0.5 text-[10px] rounded text-blue-500/70 hover:bg-blue-500/10 transition-colors"
          >
            编辑
          </button>
        )}

        {onExport && (
          <button
            onClick={onExport}
            className="px-1.5 py-0.5 text-[10px] rounded text-[var(--color-text-secondary)] hover:bg-[var(--color-bg-secondary)] transition-colors"
            title="导出为 JSON 文件"
          >
            导出
          </button>
        )}

        {onRemove && (
          <button
            onClick={onRemove}
            className="px-1.5 py-0.5 text-[10px] rounded text-red-500/70 hover:bg-red-500/10 transition-colors"
          >
            删除
          </button>
        )}
      </div>

      <div className="text-[10px] text-[var(--color-text-secondary)] mt-0.5">
        {skill.description}
      </div>

      {skill.autoActivate && skill.triggerPatterns?.length ? (
        <div className="text-[10px] text-[var(--color-text-secondary)] mt-0.5">
          触发词: {skill.triggerPatterns.slice(0, 3).join(" · ")}
          {skill.triggerPatterns.length > 3 && " ..."}
        </div>
      ) : null}

      {skill.systemPrompt && (
        <>
          <button
            onClick={() => setExpanded((v) => !v)}
            className="text-[10px] text-blue-500 mt-1 hover:underline"
          >
            {expanded ? "收起提示词" : "查看提示词"}
          </button>
          {expanded && (
            <pre className="mt-1 text-[10px] whitespace-pre-wrap text-[var(--color-text-secondary)] bg-[var(--color-bg-secondary)] rounded p-2 max-h-40 overflow-auto">
              {skill.systemPrompt}
            </pre>
          )}
        </>
      )}
    </div>
  );
}

// ── 创建/编辑表单 ──

function SkillForm({
  editing,
  onSave,
  onCancel,
}: {
  editing: AgentSkill | null;
  onSave: (input: AgentSkillInput | Partial<AgentSkill>) => Promise<void>;
  onCancel: () => void;
}) {
  const [name, setName] = useState(editing?.name ?? "");
  const [description, setDescription] = useState(editing?.description ?? "");
  const [systemPrompt, setSystemPrompt] = useState(editing?.systemPrompt ?? "");
  const [triggerPatterns, setTriggerPatterns] = useState(
    editing?.triggerPatterns?.join("\n") ?? "",
  );
  const [category, setCategory] = useState(editing?.category ?? "");
  const [saving, setSaving] = useState(false);

  const isEdit = !!editing;

  const handleSubmit = async () => {
    if (!name.trim() || !systemPrompt.trim()) return;
    setSaving(true);
    try {
      const patterns = triggerPatterns
        .split("\n")
        .map((s) => s.trim())
        .filter(Boolean);

      if (isEdit) {
        await onSave({
          name: name.trim(),
          description: description.trim(),
          systemPrompt: systemPrompt.trim(),
          triggerPatterns: patterns.length > 0 ? patterns : undefined,
          autoActivate: patterns.length > 0,
          category: category.trim() || undefined,
        });
      } else {
        await onSave({
          name: name.trim(),
          description: description.trim(),
          version: "1.0.0",
          enabled: true,
          autoActivate: patterns.length > 0,
          triggerPatterns: patterns.length > 0 ? patterns : undefined,
          systemPrompt: systemPrompt.trim(),
          category: category.trim() || undefined,
          source: "user",
        } as AgentSkillInput);
      }
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="space-y-2 rounded border border-blue-500/30 bg-blue-500/5 p-2.5">
      <div className="text-xs font-medium text-blue-500">
        {isEdit ? `编辑: ${editing.name}` : "新建技能"}
      </div>

      <input
        value={name}
        onChange={(e) => setName(e.target.value)}
        placeholder="技能名称"
        className="w-full px-2 py-1.5 text-xs rounded border border-[var(--color-border)] bg-[var(--color-bg)] outline-none focus:border-blue-500/50"
      />

      <input
        value={description}
        onChange={(e) => setDescription(e.target.value)}
        placeholder="简短描述"
        className="w-full px-2 py-1.5 text-xs rounded border border-[var(--color-border)] bg-[var(--color-bg)] outline-none focus:border-blue-500/50"
      />

      <input
        value={category}
        onChange={(e) => setCategory(e.target.value)}
        placeholder="分类标签（如 coding, writing, devops）"
        className="w-full px-2 py-1.5 text-xs rounded border border-[var(--color-border)] bg-[var(--color-bg)] outline-none focus:border-blue-500/50"
      />

      <textarea
        value={systemPrompt}
        onChange={(e) => setSystemPrompt(e.target.value)}
        placeholder="系统提示词（Markdown 格式的领域知识和行为约束）"
        rows={6}
        className="w-full px-2 py-1.5 text-xs rounded border border-[var(--color-border)] bg-[var(--color-bg)] resize-y outline-none focus:border-blue-500/50"
      />

      <textarea
        value={triggerPatterns}
        onChange={(e) => setTriggerPatterns(e.target.value)}
        placeholder="触发模式（每行一个正则，留空则需手动固定激活）"
        rows={2}
        className="w-full px-2 py-1.5 text-xs rounded border border-[var(--color-border)] bg-[var(--color-bg)] resize-y outline-none focus:border-blue-500/50"
      />

      <div className="flex items-center gap-2">
        <button
          onClick={handleSubmit}
          disabled={saving || !name.trim() || !systemPrompt.trim()}
          className="px-3 py-1.5 text-xs rounded bg-blue-500/15 text-blue-500 hover:bg-blue-500/25 disabled:opacity-50 transition-colors"
        >
          {saving ? "保存中..." : isEdit ? "保存修改" : "创建"}
        </button>
        <button
          onClick={onCancel}
          className="px-3 py-1.5 text-xs rounded bg-[var(--color-bg-secondary)] text-[var(--color-text-secondary)] hover:bg-[var(--color-bg-hover)] transition-colors"
        >
          取消
        </button>
      </div>
    </div>
  );
}
