import React, { useState, lazy, Suspense } from "react";
import type { AgentScheduledTask, AgentTaskStatus } from "@/core/ai/types";
import type { AgentTool } from "../core/react-agent";
import type {
  ScheduledFilterMode,
  ScheduledSortMode,
  WorkbenchTab,
} from "../core/ui-state";
import { SkillsManager } from "@/components/ai/SkillsManager";
import type { AgentSessionFileInsight } from "../core/session-insights";

const TaskCenterPanel = lazy(() => import("./TaskCenterPanel"));
const KnowledgeGraphView = lazy(() => import("./KnowledgeGraphView"));

function isTaskDue(nextRunAt?: number, status?: AgentTaskStatus) {
  return typeof nextRunAt === "number" && nextRunAt <= Date.now() && status === "pending";
}

/** 图谱 Tab 内容：展示 ActorSystem 拓扑或知识图谱 */
function GraphTabContent() {
  const [mode, setMode] = React.useState<"actor" | "knowledge">("actor");

  // 获取 ActorSystem 拓扑数据
  const actorSystemStore = React.useMemo(() => {
    try {
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const { useActorSystemStore } = require("@/store/actor-system-store");
      return useActorSystemStore.getState();
    } catch { return null; }
  }, []);

  const actorData = React.useMemo(() => {
    const { KnowledgeGraph } = require("@/core/knowledge/knowledge-graph");
    if (mode === "actor" && actorSystemStore) {
      const actors = (actorSystemStore.actors || []).map((a: any) => ({
        id: a.id, name: a.roleName, status: a.status, capabilities: a.capabilities?.tags,
      }));
      const tasks = (actorSystemStore.spawnedTaskEvents || []).map((e: any) => ({
        spawner: e.spawnerActorId, target: e.targetActorId, label: e.label || "", status: e.status,
      }));
      const dialog = (actorSystemStore.dialogHistory || []).map((m: any) => ({ from: m.from, to: m.to }));
      return KnowledgeGraph.fromActorSystem(actors, tasks, dialog);
    }
    // 知识图谱模式
    const { globalKnowledgeGraph } = require("@/core/knowledge/knowledge-graph");
    return globalKnowledgeGraph.toVisualizationData();
  }, [mode, actorSystemStore]);

  return (
    <div className="flex flex-col h-full">
      <div className="flex items-center gap-1 px-3 py-2 border-b border-[var(--color-border)]">
        <button
          onClick={() => setMode("actor")}
          className={`text-[10px] px-2 py-0.5 rounded ${mode === "actor" ? "bg-blue-500/15 text-blue-500" : "text-[var(--color-text-secondary)]"}`}
        >
          Agent 拓扑
        </button>
        <button
          onClick={() => setMode("knowledge")}
          className={`text-[10px] px-2 py-0.5 rounded ${mode === "knowledge" ? "bg-blue-500/15 text-blue-500" : "text-[var(--color-text-secondary)]"}`}
        >
          知识图谱
        </button>
      </div>
      {actorData.nodes.length === 0 ? (
        <div className="flex-1 flex items-center justify-center text-xs text-[var(--color-text-secondary)]">
          {mode === "actor" ? "暂无 Agent 运行数据，请先启动对话" : "暂无知识图谱数据"}
        </div>
      ) : (
        <KnowledgeGraphView data={actorData} className="flex-1" />
      )}
    </div>
  );
}

interface AgentWorkbenchPanelProps {
  visible: boolean;
  workbenchTab: WorkbenchTab;
  onSelectTab: (tab: WorkbenchTab) => void;
  onClose: () => void;
  currentSessionTitle?: string;
  sessionReview: {
    visibleTaskCount: number;
    hiddenTaskCount: number;
    compactedTaskCount: number;
    totalStepCount: number;
    uniqueToolCount: number;
    latestAnswerPreview?: string;
    latestQueryPreview?: string;
  };
  sessionFiles: AgentSessionFileInsight[];
  sessionContextLines: string[];
  sessionCompactionSummary?: string;
  availableTools: AgentTool[];
  scheduledStats: {
    total: number;
    running: number;
    error: number;
    skipped: number;
  };
  scheduledStatusFilter: ScheduledFilterMode;
  onChangeScheduledStatusFilter: (mode: ScheduledFilterMode) => void;
  scheduledSortMode: ScheduledSortMode;
  onChangeScheduledSortMode: (mode: ScheduledSortMode) => void;
  visibleScheduledTasks: AgentScheduledTask[];
  scheduledQuery: string;
  onChangeScheduledQuery: (value: string) => void;
  scheduledType: "once" | "interval" | "cron";
  onChangeScheduledType: (value: "once" | "interval" | "cron") => void;
  scheduledValue: string;
  onChangeScheduledValue: (value: string) => void;
  onCreateScheduledTask: () => void;
  onRefreshScheduledTasks: () => void;
  onPauseTask: (taskId: string) => void;
  onResumeTask: (taskId: string) => void;
  onCancelTask: (taskId: string) => void;
}

export function AgentWorkbenchPanel({
  visible,
  workbenchTab,
  onSelectTab,
  onClose,
  currentSessionTitle,
  sessionReview,
  sessionFiles,
  sessionContextLines,
  sessionCompactionSummary,
  availableTools,
  scheduledStats,
  scheduledStatusFilter,
  onChangeScheduledStatusFilter,
  scheduledSortMode,
  onChangeScheduledSortMode,
  visibleScheduledTasks,
  scheduledQuery,
  onChangeScheduledQuery,
  scheduledType,
  onChangeScheduledType,
  scheduledValue,
  onChangeScheduledValue,
  onCreateScheduledTask,
  onRefreshScheduledTasks,
  onPauseTask,
  onResumeTask,
  onCancelTask,
}: AgentWorkbenchPanelProps) {
  if (!visible) return null;

  return (
    <>
      <div className="absolute inset-0 bg-black/10 z-10 md:hidden" onClick={onClose} />
      <aside className="absolute right-0 top-0 bottom-0 z-20 w-[340px] max-w-[90vw] border-l border-[var(--color-border)] bg-[var(--color-bg)] shadow-2xl flex flex-col">
        <div className="px-3 py-2 border-b border-[var(--color-border)] flex items-center gap-1.5">
          <span className="text-xs font-semibold">Agent 工作台</span>
          <div className="ml-1 inline-flex items-center rounded border border-[var(--color-border)] bg-[var(--color-bg-secondary)]/70 p-0.5">
            <button
              onClick={() => onSelectTab("review")}
              className={`px-2 py-0.5 text-[10px] rounded ${
                workbenchTab === "review"
                  ? "bg-[var(--color-bg)] text-[var(--color-text)]"
                  : "text-[var(--color-text-secondary)]"
              }`}
            >
              审查
            </button>
            <button
              onClick={() => onSelectTab("files")}
              className={`px-2 py-0.5 text-[10px] rounded ${
                workbenchTab === "files"
                  ? "bg-[var(--color-bg)] text-[var(--color-text)]"
                  : "text-[var(--color-text-secondary)]"
              }`}
            >
              文件
            </button>
            <button
              onClick={() => onSelectTab("context")}
              className={`px-2 py-0.5 text-[10px] rounded ${
                workbenchTab === "context"
                  ? "bg-[var(--color-bg)] text-[var(--color-text)]"
                  : "text-[var(--color-text-secondary)]"
              }`}
            >
              上下文
            </button>
            <button
              onClick={() => onSelectTab("tools")}
              className={`px-2 py-0.5 text-[10px] rounded ${
                workbenchTab === "tools"
                  ? "bg-[var(--color-bg)] text-[var(--color-text)]"
                  : "text-[var(--color-text-secondary)]"
              }`}
            >
              工具
            </button>
            <button
              onClick={() => onSelectTab("orchestrator")}
              className={`px-2 py-0.5 text-[10px] rounded ${
                workbenchTab === "orchestrator"
                  ? "bg-[var(--color-bg)] text-[var(--color-text)]"
                  : "text-[var(--color-text-secondary)]"
              }`}
            >
              编排
            </button>
            <button
              onClick={() => onSelectTab("skills")}
              className={`px-2 py-0.5 text-[10px] rounded ${
                workbenchTab === "skills"
                  ? "bg-[var(--color-bg)] text-[var(--color-text)]"
                  : "text-[var(--color-text-secondary)]"
              }`}
            >
              技能
            </button>
            <button
              onClick={() => onSelectTab("tasks")}
              className={`px-2 py-0.5 text-[10px] rounded ${
                workbenchTab === "tasks"
                  ? "bg-[var(--color-bg)] text-[var(--color-text)]"
                  : "text-[var(--color-text-secondary)]"
              }`}
            >
              任务
            </button>
            <button
              onClick={() => onSelectTab("graph")}
              className={`px-2 py-0.5 text-[10px] rounded ${
                workbenchTab === "graph"
                  ? "bg-[var(--color-bg)] text-[var(--color-text)]"
                  : "text-[var(--color-text-secondary)]"
              }`}
            >
              图谱
            </button>
          </div>
          <button
            onClick={onClose}
            className="ml-auto text-[10px] px-2 py-0.5 rounded border border-[var(--color-border)] hover:bg-[var(--color-bg-secondary)]"
          >
            关闭
          </button>
        </div>
        <div className="flex-1 overflow-auto">
          {workbenchTab === "review" && (
            <div className="p-3 space-y-3">
              <div>
                <div className="text-xs font-semibold">当前会话审查</div>
                {currentSessionTitle && (
                  <div className="mt-1 text-[11px] text-[var(--color-text-secondary)]">
                    {currentSessionTitle}
                  </div>
                )}
              </div>
              <div className="grid grid-cols-2 gap-2">
                <div className="rounded-xl border border-[var(--color-border)] bg-[var(--color-bg-secondary)]/55 p-2">
                  <div className="text-[10px] text-[var(--color-text-secondary)]">可见任务</div>
                  <div className="mt-1 text-lg font-semibold">{sessionReview.visibleTaskCount}</div>
                </div>
                <div className="rounded-xl border border-[var(--color-border)] bg-[var(--color-bg-secondary)]/55 p-2">
                  <div className="text-[10px] text-[var(--color-text-secondary)]">总步骤</div>
                  <div className="mt-1 text-lg font-semibold">{sessionReview.totalStepCount}</div>
                </div>
                <div className="rounded-xl border border-[var(--color-border)] bg-[var(--color-bg-secondary)]/55 p-2">
                  <div className="text-[10px] text-[var(--color-text-secondary)]">工具种类</div>
                  <div className="mt-1 text-lg font-semibold">{sessionReview.uniqueToolCount}</div>
                </div>
                <div className="rounded-xl border border-[var(--color-border)] bg-[var(--color-bg-secondary)]/55 p-2">
                  <div className="text-[10px] text-[var(--color-text-secondary)]">收起/摘要</div>
                  <div className="mt-1 text-sm font-semibold">
                    {sessionReview.hiddenTaskCount} / {sessionReview.compactedTaskCount}
                  </div>
                </div>
              </div>
              {sessionReview.latestQueryPreview && (
                <div className="rounded-xl border border-[var(--color-border)] bg-[var(--color-bg-secondary)]/55 p-2">
                  <div className="text-[10px] text-[var(--color-text-secondary)]">最近任务</div>
                  <div className="mt-1 text-[12px] leading-5">{sessionReview.latestQueryPreview}</div>
                </div>
              )}
              {sessionReview.latestAnswerPreview && (
                <div className="rounded-xl border border-[var(--color-border)] bg-[var(--color-bg-secondary)]/55 p-2">
                  <div className="text-[10px] text-[var(--color-text-secondary)]">最近结果</div>
                  <div className="mt-1 text-[12px] leading-5 text-[var(--color-text-secondary)]">
                    {sessionReview.latestAnswerPreview}
                  </div>
                </div>
              )}
            </div>
          )}

          {workbenchTab === "files" && (
            <div className="p-3 space-y-2">
              <div className="text-xs font-semibold">当前工作集文件</div>
              {sessionFiles.length === 0 ? (
                <div className="text-[11px] text-[var(--color-text-secondary)]">
                  当前会话还没有明确工作集文件或工具路径。
                </div>
              ) : (
                sessionFiles.map((file) => (
                  <div
                    key={`${file.path}-${file.source}`}
                    className="rounded-xl border border-[var(--color-border)] bg-[var(--color-bg-secondary)]/55 p-2"
                  >
                    <div className="break-all text-[12px] leading-5">{file.path}</div>
                    <div className="mt-1 text-[10px] text-[var(--color-text-secondary)]">
                      来源：{file.source} · 提及 {file.mentions} 次
                      {file.latestAt
                        ? ` · 最近 ${new Date(file.latestAt).toLocaleTimeString()}`
                        : ""}
                    </div>
                  </div>
                ))
              )}
            </div>
          )}

          {workbenchTab === "context" && (
            <div className="p-3 space-y-3">
              <div className="text-xs font-semibold">上下文边界</div>
              {sessionContextLines.length === 0 ? (
                <div className="text-[11px] text-[var(--color-text-secondary)]">
                  当前上下文仍是完整会话，没有额外的分支、摘要或待执行跟进。
                </div>
              ) : (
                <div className="space-y-2">
                  {sessionContextLines.map((line) => (
                    <div
                      key={line}
                      className="rounded-xl border border-[var(--color-border)] bg-[var(--color-bg-secondary)]/55 p-2 text-[12px] leading-5"
                    >
                      {line}
                    </div>
                  ))}
                </div>
              )}
              {sessionCompactionSummary && (
                <div className="rounded-xl border border-emerald-500/20 bg-emerald-500/[0.07] p-2">
                  <div className="text-[10px] text-emerald-700">历史摘要</div>
                  <div className="mt-1 whitespace-pre-wrap text-[12px] leading-5 text-emerald-700/90">
                    {sessionCompactionSummary}
                  </div>
                </div>
              )}
            </div>
          )}

          {workbenchTab === "tools" && (
            <div className="p-3 border-b border-[var(--color-border)]/70">
              <p className="text-xs text-[var(--color-text-secondary)] mb-1">
                Agent 可调用的工具:
              </p>
              <div className="flex flex-wrap gap-1">
                {availableTools.map((tool) => (
                  <span
                    key={tool.name}
                    className="text-[11px] px-2 py-0.5 bg-[var(--color-bg-secondary)] rounded"
                    title={tool.description}
                  >
                    {tool.name}
                  </span>
                ))}
              </div>
            </div>
          )}

          {workbenchTab === "orchestrator" && (
            <div className="p-3 space-y-3">
              <div className="text-xs font-semibold">任务编排</div>
              <div className="flex items-center gap-2 flex-wrap">
                <span className="text-[10px] text-[var(--color-text-secondary)]">
                  状态筛选
                </span>
                <select
                  value={scheduledStatusFilter}
                  onChange={(e) =>
                    onChangeScheduledStatusFilter(e.target.value as ScheduledFilterMode)
                  }
                  className="px-2 py-1 text-[10px] rounded border border-[var(--color-border)] bg-[var(--color-bg)]"
                >
                  <option value="all">all</option>
                  <option value="attention">attention(异常/跳过)</option>
                  <option value="pending">pending</option>
                  <option value="running">running</option>
                  <option value="success">success</option>
                  <option value="error">error</option>
                  <option value="paused">paused</option>
                  <option value="cancelled">cancelled</option>
                </select>
                <span className="text-[10px] text-[var(--color-text-secondary)]">
                  排序
                </span>
                <select
                  value={scheduledSortMode}
                  onChange={(e) =>
                    onChangeScheduledSortMode(e.target.value as ScheduledSortMode)
                  }
                  className="px-2 py-1 text-[10px] rounded border border-[var(--color-border)] bg-[var(--color-bg)]"
                >
                  <option value="next_run_asc">next_run asc</option>
                  <option value="updated_desc">updated desc</option>
                  <option value="created_desc">created desc</option>
                </select>
                <span className="text-[10px] text-[var(--color-text-secondary)]">
                  显示 {visibleScheduledTasks.length}/{scheduledStats.total}
                </span>
                <span className="text-[10px] text-[var(--color-text-secondary)]">
                  running {scheduledStats.running} · error {scheduledStats.error} · skipped{" "}
                  {scheduledStats.skipped}
                </span>
              </div>
              <div className="grid grid-cols-1 gap-2">
                <input
                  value={scheduledQuery}
                  onChange={(e) => onChangeScheduledQuery(e.target.value)}
                  className="px-2 py-1.5 text-xs rounded border border-[var(--color-border)] bg-[var(--color-bg)]"
                  placeholder="任务内容，例如：每天汇总今日待办并提醒我"
                />
                <div className="grid grid-cols-2 gap-2">
                  <select
                    value={scheduledType}
                    onChange={(e) =>
                      onChangeScheduledType(e.target.value as "once" | "interval" | "cron")
                    }
                    className="px-2 py-1.5 text-xs rounded border border-[var(--color-border)] bg-[var(--color-bg)]"
                  >
                    <option value="once">once</option>
                    <option value="interval">interval</option>
                    <option value="cron">cron</option>
                  </select>
                  <input
                    value={scheduledValue}
                    onChange={(e) => onChangeScheduledValue(e.target.value)}
                    className="px-2 py-1.5 text-xs rounded border border-[var(--color-border)] bg-[var(--color-bg)]"
                    placeholder={
                      scheduledType === "once"
                        ? "2026-02-22T23:00:00"
                        : scheduledType === "interval"
                          ? "300000"
                          : "*/5 * * * *"
                    }
                  />
                </div>
              </div>
              <div className="flex items-center gap-2">
                <button
                  onClick={onCreateScheduledTask}
                  className="px-2.5 py-1.5 text-xs rounded bg-emerald-500/15 text-emerald-500 hover:bg-emerald-500/25"
                >
                  新建任务
                </button>
                <button
                  onClick={onRefreshScheduledTasks}
                  className="px-2.5 py-1.5 text-xs rounded bg-[var(--color-bg-secondary)] hover:bg-[var(--color-bg-tertiary)]"
                >
                  刷新
                </button>
              </div>
              <span className="block text-[10px] text-[var(--color-text-secondary)]">
                once: 时间点 / interval: 毫秒 / cron: 5 段表达式
              </span>

              <div className="space-y-1.5 max-h-[45vh] overflow-auto pr-1">
                {visibleScheduledTasks.length === 0 && (
                  <div className="text-[10px] text-[var(--color-text-secondary)]">
                    暂无符合筛选条件的编排任务
                  </div>
                )}
                {visibleScheduledTasks.map((task) => (
                  <div
                    key={task.id}
                    className="rounded border border-[var(--color-border)] bg-[var(--color-bg)] px-2 py-1.5 flex items-center justify-between gap-2"
                  >
                    <div className="min-w-0">
                      <div className="text-xs truncate">{task.query}</div>
                      <div className="text-[10px] text-[var(--color-text-secondary)]">
                        {task.schedule_type || "manual"}{" "}
                        {task.schedule_value ? `· ${task.schedule_value}` : ""}
                        {" · "}
                        {task.status}
                        {typeof task.retry_count === "number"
                          ? ` · retry ${task.retry_count}`
                          : ""}
                        {task.last_result_status
                          ? task.last_result_status === "skipped"
                            ? ` · last skipped(${task.last_skip_reason === "overlap_running" ? "overlap" : task.last_skip_reason || "unknown"})`
                            : ` · last ${task.last_result_status}`
                          : ""}
                      </div>
                      <div className="text-[10px] text-[var(--color-text-secondary)]">
                        {typeof task.next_run_at === "number"
                          ? `next: ${new Date(task.next_run_at).toLocaleString()}`
                          : "next: -"}
                        {isTaskDue(task.next_run_at, task.status)
                          ? " · due"
                          : ""}
                        {typeof task.last_duration_ms === "number"
                          ? ` · duration: ${task.last_duration_ms}ms`
                          : ""}
                      </div>
                      <div className="text-[10px] text-[var(--color-text-secondary)]">
                        {typeof task.last_started_at === "number"
                          ? `started: ${new Date(task.last_started_at).toLocaleString()}`
                          : "started: -"}
                        {" · "}
                        {typeof task.last_finished_at === "number"
                          ? `finished: ${new Date(task.last_finished_at).toLocaleString()}`
                          : "finished: -"}
                      </div>
                      {task.last_error && (
                        <div className="text-[10px] text-red-500 truncate">
                          err: {task.last_error}
                        </div>
                      )}
                    </div>
                    <div className="flex items-center gap-1 shrink-0">
                      {task.status === "paused" ? (
                        <button
                          onClick={() => onResumeTask(task.id)}
                          className="px-2 py-0.5 text-[10px] rounded bg-emerald-500/15 text-emerald-500"
                        >
                          恢复
                        </button>
                      ) : (
                        <button
                          onClick={() => onPauseTask(task.id)}
                          className="px-2 py-0.5 text-[10px] rounded bg-amber-500/15 text-amber-500"
                        >
                          暂停
                        </button>
                      )}
                      <button
                        onClick={() => onCancelTask(task.id)}
                        className="px-2 py-0.5 text-[10px] rounded bg-red-500/15 text-red-500"
                      >
                        取消
                      </button>
                    </div>
                  </div>
                ))}
              </div>
            </div>
          )}

          {workbenchTab === "skills" && (
            <div className="p-3">
              <SkillsManager compact />
            </div>
          )}

          {workbenchTab === "tasks" && (
            <Suspense fallback={<div className="p-3 text-xs text-[var(--color-text-secondary)]">加载中...</div>}>
              <TaskCenterPanel />
            </Suspense>
          )}

          {workbenchTab === "graph" && (
            <Suspense fallback={<div className="p-3 text-xs text-[var(--color-text-secondary)]">加载中...</div>}>
              <GraphTabContent />
            </Suspense>
          )}
        </div>
      </aside>
    </>
  );
}
