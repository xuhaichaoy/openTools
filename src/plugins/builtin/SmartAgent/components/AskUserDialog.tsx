import React, { useState, useRef, useEffect, useCallback } from "react";
import { HelpCircle, Send, Check, ChevronLeft, ChevronRight } from "lucide-react";
import type {
  AskUserQuestion,
  AskUserAnswers,
} from "../core/default-tools";

interface AskUserDialogProps {
  questions: AskUserQuestion[];
  onSubmit: (answers: AskUserAnswers) => void;
}

function SingleSelect({
  question,
  selected,
  customText,
  onSelect,
  onCustomChange,
}: {
  question: AskUserQuestion;
  selected: string | null;
  customText: string;
  onSelect: (val: string) => void;
  onCustomChange: (val: string) => void;
}) {
  const isCustom = selected === "__custom__";
  return (
    <div className="flex flex-col gap-1.5">
      {question.options?.map((opt) => (
        <div
          key={opt}
          onClick={() => onSelect(opt)}
          className={`flex items-center gap-2.5 px-3 py-2 text-sm rounded-lg border cursor-pointer transition-colors select-none ${
            selected === opt
              ? "border-blue-500/50 bg-blue-500/10 text-blue-400"
              : "border-[var(--color-border)] text-[var(--color-text)] hover:bg-[var(--color-bg-secondary)]"
          }`}
        >
          <span
            className={`w-4 h-4 rounded-full border-2 flex items-center justify-center shrink-0 ${
              selected === opt ? "border-blue-500" : "border-[var(--color-text-secondary)]"
            }`}
          >
            {selected === opt && (
              <span className="w-2 h-2 rounded-full bg-blue-500" />
            )}
          </span>
          {opt}
        </div>
      ))}
      <label
        className={`flex items-center gap-2.5 px-3 py-2 text-sm rounded-lg border cursor-pointer transition-colors ${
          isCustom
            ? "border-blue-500/50 bg-blue-500/10 text-blue-400"
            : "border-[var(--color-border)] text-[var(--color-text-secondary)] hover:bg-[var(--color-bg-secondary)]"
        }`}
      >
        <span
          className={`w-4 h-4 rounded-full border-2 flex items-center justify-center shrink-0 ${
            isCustom ? "border-blue-500" : "border-[var(--color-text-secondary)]"
          }`}
        >
          {isCustom && (
            <span className="w-2 h-2 rounded-full bg-blue-500" />
          )}
        </span>
        <input
          type="text"
          className="flex-1 bg-transparent outline-none placeholder:text-[var(--color-text-secondary)]"
          placeholder="自定义输入..."
          value={customText}
          onFocus={() => onSelect("__custom__")}
          onChange={(e) => {
            onSelect("__custom__");
            onCustomChange(e.target.value);
          }}
        />
      </label>
    </div>
  );
}

function MultiSelect({
  question,
  selected,
  customText,
  onToggle,
  onCustomChange,
}: {
  question: AskUserQuestion;
  selected: Set<string>;
  customText: string;
  onToggle: (val: string) => void;
  onCustomChange: (val: string) => void;
}) {
  const hasCustom = selected.has("__custom__");
  return (
    <div className="flex flex-col gap-1.5">
      {question.options?.map((opt) => {
        const checked = selected.has(opt);
        return (
          <div
            key={opt}
            onClick={() => onToggle(opt)}
            className={`flex items-center gap-2.5 px-3 py-2 text-sm rounded-lg border cursor-pointer transition-colors select-none ${
              checked
                ? "border-blue-500/50 bg-blue-500/10 text-blue-400"
                : "border-[var(--color-border)] text-[var(--color-text)] hover:bg-[var(--color-bg-secondary)]"
            }`}
          >
            <span
              className={`w-4 h-4 rounded flex items-center justify-center shrink-0 border ${
                checked ? "bg-blue-500 border-blue-500" : "border-[var(--color-text-secondary)]"
              }`}
            >
              {checked && <Check className="w-3 h-3 text-white" />}
            </span>
            {opt}
          </div>
        );
      })}
      <label
        className={`flex items-center gap-2.5 px-3 py-2 text-sm rounded-lg border cursor-pointer transition-colors ${
          hasCustom
            ? "border-blue-500/50 bg-blue-500/10 text-blue-400"
            : "border-[var(--color-border)] text-[var(--color-text-secondary)] hover:bg-[var(--color-bg-secondary)]"
        }`}
      >
        <span
          className={`w-4 h-4 rounded flex items-center justify-center shrink-0 border ${
            hasCustom ? "bg-blue-500 border-blue-500" : "border-[var(--color-text-secondary)]"
          }`}
        >
          {hasCustom && <Check className="w-3 h-3 text-white" />}
        </span>
        <input
          type="text"
          className="flex-1 bg-transparent outline-none placeholder:text-[var(--color-text-secondary)]"
          placeholder="自定义输入..."
          value={customText}
          onFocus={() => {
            if (!hasCustom) onToggle("__custom__");
          }}
          onChange={(e) => {
            if (!hasCustom) onToggle("__custom__");
            onCustomChange(e.target.value);
          }}
        />
      </label>
    </div>
  );
}

function TextInput({
  value,
  onChange,
  inputRef,
}: {
  value: string;
  onChange: (val: string) => void;
  inputRef?: React.RefObject<HTMLTextAreaElement | null>;
}) {
  return (
    <textarea
      ref={inputRef as React.RefObject<HTMLTextAreaElement>}
      value={value}
      onChange={(e) => onChange(e.target.value)}
      className="w-full bg-[var(--color-bg-secondary)] text-[var(--color-text)] text-sm px-3 py-2 rounded-lg border border-[var(--color-border)] outline-none resize-none min-h-[56px] max-h-[120px] focus:border-blue-500/30"
      placeholder="输入你的回答..."
      rows={2}
    />
  );
}

export function AskUserDialog({ questions, onSubmit }: AskUserDialogProps) {
  const [step, setStep] = useState(0);
  const [singleAnswers, setSingleAnswers] = useState<Record<string, string | null>>({});
  const [multiAnswers, setMultiAnswers] = useState<Record<string, Set<string>>>({});
  const [textAnswers, setTextAnswers] = useState<Record<string, string>>({});
  const [customTexts, setCustomTexts] = useState<Record<string, string>>({});
  const textInputRef = useRef<HTMLTextAreaElement>(null);

  const total = questions.length;
  const isMultiStep = total > 1;
  const current = questions[step];
  const isLast = step === total - 1;
  const isFirst = step === 0;

  useEffect(() => {
    if (current?.type === "text") {
      textInputRef.current?.focus();
    }
  }, [step, current?.type]);

  const isCurrentAnswered = useCallback(() => {
    if (!current) return false;
    if (current.type === "single") {
      const sel = singleAnswers[current.id];
      if (!sel) return false;
      if (sel === "__custom__") return (customTexts[current.id] || "").trim().length > 0;
      return true;
    }
    if (current.type === "multi") {
      const sel = multiAnswers[current.id];
      if (!sel || sel.size === 0) return false;
      if (sel.has("__custom__")) return (customTexts[current.id] || "").trim().length > 0;
      return true;
    }
    return (textAnswers[current.id] || "").trim().length > 0;
  }, [current, singleAnswers, multiAnswers, textAnswers, customTexts]);

  const handleSubmit = useCallback(() => {
    const answers: AskUserAnswers = {};
    for (const q of questions) {
      if (q.type === "single") {
        const sel = singleAnswers[q.id];
        answers[q.id] = sel === "__custom__" ? customTexts[q.id]?.trim() || "" : sel || "";
      } else if (q.type === "multi") {
        const sel = multiAnswers[q.id] || new Set();
        const vals = [...sel].map((v) =>
          v === "__custom__" ? customTexts[q.id]?.trim() || "" : v,
        ).filter(Boolean);
        answers[q.id] = vals;
      } else {
        answers[q.id] = (textAnswers[q.id] || "").trim();
      }
    }
    onSubmit(answers);
  }, [questions, singleAnswers, multiAnswers, textAnswers, customTexts, onSubmit]);

  const handleNext = useCallback(() => {
    if (isLast) {
      handleSubmit();
    } else {
      setStep((s) => Math.min(s + 1, total - 1));
    }
  }, [isLast, handleSubmit, total]);

  if (!current) return null;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 backdrop-blur-sm">
      <div className="bg-[var(--color-bg)] border border-[var(--color-border)] rounded-xl shadow-2xl w-[460px] max-h-[80vh] flex flex-col">
        {/* Header */}
        <div className="flex items-center justify-between p-4 pb-2">
          <div className="flex items-center gap-2">
            <div className="w-8 h-8 rounded-full bg-blue-500/10 flex items-center justify-center shrink-0">
              <HelpCircle className="w-4 h-4 text-blue-500" />
            </div>
            <h3 className="text-sm font-semibold text-[var(--color-text)]">
              Agent 需要你的输入
            </h3>
          </div>
          {isMultiStep && (
            <span className="text-xs text-[var(--color-text-secondary)] tabular-nums">
              {step + 1} / {total}
            </span>
          )}
        </div>

        {/* Progress bar */}
        {isMultiStep && (
          <div className="px-4 pb-1">
            <div className="h-1 rounded-full bg-[var(--color-border)] overflow-hidden">
              <div
                className="h-full bg-blue-500 rounded-full transition-all duration-300"
                style={{ width: `${((step + 1) / total) * 100}%` }}
              />
            </div>
          </div>
        )}

        {/* Current question */}
        <div className="overflow-y-auto px-4 py-3 flex-1">
          <p className="text-sm font-medium text-[var(--color-text)] mb-3 leading-relaxed">
            {current.question}
            {current.type === "multi" && (
              <span className="text-xs text-[var(--color-text-secondary)] ml-1.5">
                (可多选)
              </span>
            )}
          </p>

          {current.type === "single" && current.options && current.options.length > 0 && (
            <SingleSelect
              question={current}
              selected={singleAnswers[current.id] ?? null}
              customText={customTexts[current.id] || ""}
              onSelect={(val) =>
                setSingleAnswers((prev) => ({ ...prev, [current.id]: val }))
              }
              onCustomChange={(val) =>
                setCustomTexts((prev) => ({ ...prev, [current.id]: val }))
              }
            />
          )}

          {current.type === "multi" && current.options && current.options.length > 0 && (
            <MultiSelect
              question={current}
              selected={multiAnswers[current.id] || new Set()}
              customText={customTexts[current.id] || ""}
              onToggle={(val) =>
                setMultiAnswers((prev) => {
                  const s = new Set(prev[current.id] || []);
                  if (s.has(val)) s.delete(val);
                  else s.add(val);
                  return { ...prev, [current.id]: s };
                })
              }
              onCustomChange={(val) =>
                setCustomTexts((prev) => ({ ...prev, [current.id]: val }))
              }
            />
          )}

          {current.type === "text" && (
            <TextInput
              value={textAnswers[current.id] || ""}
              onChange={(val) =>
                setTextAnswers((prev) => ({ ...prev, [current.id]: val }))
              }
              inputRef={textInputRef}
            />
          )}
        </div>

        {/* Footer buttons */}
        <div className="p-4 pt-2 flex items-center gap-2">
          {isMultiStep && !isFirst && (
            <button
              onClick={() => setStep((s) => Math.max(s - 1, 0))}
              className="flex items-center gap-1 px-3 py-2.5 rounded-lg border border-[var(--color-border)] text-[var(--color-text-secondary)] text-sm hover:bg-[var(--color-bg-secondary)] transition-colors"
            >
              <ChevronLeft className="w-3.5 h-3.5" />
              上一题
            </button>
          )}
          <button
            onClick={handleNext}
            disabled={!isCurrentAnswered()}
            className="flex-1 flex items-center justify-center gap-2 px-4 py-2.5 rounded-lg bg-blue-500 text-white text-sm font-medium hover:bg-blue-600 disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
          >
            {isLast ? (
              <>
                <Send className="w-3.5 h-3.5" />
                提交
              </>
            ) : (
              <>
                下一题
                <ChevronRight className="w-3.5 h-3.5" />
              </>
            )}
          </button>
        </div>
      </div>
    </div>
  );
}
