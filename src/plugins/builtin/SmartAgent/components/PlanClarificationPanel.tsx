import React from "react";
import type {
  PendingPlanClarificationState,
  PlanClarificationAnswers,
  PlanClarificationQuestion,
} from "../core/ui-state";

interface PlanClarificationPanelProps {
  pendingPlanClarification: PendingPlanClarificationState | null;
  threadVersion: number;
  activeQuestion: PlanClarificationQuestion | null;
  activeQuestionIndex: number;
  questionCount: number;
  answers: PlanClarificationAnswers;
  onPrevQuestion: () => void;
  onNextQuestion: () => void;
  onSelectOption: (question: PlanClarificationQuestion, option: string) => void;
  onCustomInput: (question: PlanClarificationQuestion, value: string) => void;
  onSubmit: () => void;
  onCancel: () => void;
  busy: boolean;
  error: string | null;
  readyToSubmit: boolean;
  requiredCompletedCount: number;
  requiredTotalCount: number;
}

export function PlanClarificationPanel({
  pendingPlanClarification,
  threadVersion,
  activeQuestion,
  activeQuestionIndex,
  questionCount,
  answers,
  onPrevQuestion,
  onNextQuestion,
  onSelectOption,
  onCustomInput,
  onSubmit,
  onCancel,
  busy,
  error,
  readyToSubmit,
  requiredCompletedCount,
  requiredTotalCount,
}: PlanClarificationPanelProps) {
  if (!pendingPlanClarification) return null;

  return (
    <div className="px-3 py-2 border-b border-[var(--color-border)] bg-sky-500/[0.05] space-y-2">
      <div className="text-xs font-semibold text-sky-600">Plan Mode 需要补充信息</div>
      <div className="text-[10px] text-[var(--color-text-secondary)]">
        {pendingPlanClarification.direction === "linked"
          ? `关联当前计划 · v${threadVersion || 1}`
          : `新建计划 · v${threadVersion || 1}`}
      </div>

      {activeQuestion && (
        <>
          <div className="flex items-center gap-2 flex-end flex-end">
            <button
              onClick={onPrevQuestion}
              disabled={activeQuestionIndex === 0}
              className="px-2 py-0.5 text-[11px] rounded border border-[var(--color-border)] disabled:opacity-40"
            >
              ← 上一题
            </button>
            <span className="text-[11px] text-[var(--color-text-secondary)]">
              第 {activeQuestionIndex + 1}/{questionCount} 题
            </span>
            <button
              onClick={onNextQuestion}
              disabled={activeQuestionIndex >= questionCount - 1}
              className="px-2 py-0.5 text-[11px] rounded border border-[var(--color-border)] disabled:opacity-40"
            >
              下一题 →
            </button>
          </div>

          <div className="rounded-lg border border-[var(--color-border)]/80 bg-[var(--color-bg)]/90 px-2.5 py-2 space-y-2">
            <div className="flex items-center gap-2">
              <span className="text-[11px] text-[var(--color-text-secondary)]">
                Q{activeQuestionIndex + 1}
              </span>
              <span className="text-xs font-medium leading-snug">{activeQuestion.question}</span>
              <span className="ml-auto text-[10px] text-[var(--color-text-secondary)]">
                {activeQuestion.multiSelect ? "多选" : "单选"} ·{" "}
                {activeQuestion.required ? "必填" : "选填"}
              </span>
            </div>
            <div className="flex flex-wrap gap-1.5">
              {activeQuestion.options.map((option) => {
                const selected = !!answers[activeQuestion.id]?.selectedOptions?.includes(option);
                return (
                  <button
                    key={`${activeQuestion.id}-${option}`}
                    onClick={() => onSelectOption(activeQuestion, option)}
                    type="button"
                    className={`px-2 py-1 text-[11px] rounded-md border transition-colors ${
                      selected
                        ? "border-sky-500/40 bg-sky-500/15 text-sky-700"
                        : "border-[var(--color-border)] bg-[var(--color-bg-secondary)]/60 hover:bg-[var(--color-bg-secondary)] text-[var(--color-text-secondary)]"
                    }`}
                  >
                    {option}
                  </button>
                );
              })}
            </div>
            <div className="text-[10px] text-[var(--color-text-secondary)]">
              自定义输入（最后一项）
            </div>
            <textarea
              value={answers[activeQuestion.id]?.customInput || ""}
              onChange={(e) => onCustomInput(activeQuestion, e.target.value)}
              rows={3}
              className="w-full px-2 py-1.5 text-xs rounded-md border border-[var(--color-border)] bg-[var(--color-bg)] resize-y"
              placeholder={
                activeQuestion.placeholder ||
                (activeQuestion.required ? "请输入该问题答案" : "可选补充（可留空）")
              }
            />
          </div>
        </>
      )}

      {error && <div className="text-[11px] text-red-500">{error}</div>}

      <div className="flex items-center gap-2">
        <button
          onClick={onSubmit}
          disabled={busy}
          className="px-2.5 py-1.5 text-xs rounded bg-sky-500/20 text-sky-700 disabled:opacity-50"
        >
          {readyToSubmit ? "提交并继续计划" : "继续"}
        </button>
        <button
          onClick={onCancel}
          disabled={busy}
          className="px-2.5 py-1.5 text-xs rounded bg-[var(--color-bg-secondary)] hover:bg-[var(--color-bg-tertiary)] disabled:opacity-50"
        >
          取消
        </button>
        <span className="text-[10px] text-[var(--color-text-secondary)] ml-auto">
          必填完成 {requiredCompletedCount}/{requiredTotalCount}
        </span>
      </div>
    </div>
  );
}
