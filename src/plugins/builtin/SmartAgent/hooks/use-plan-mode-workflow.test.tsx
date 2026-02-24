/* @vitest-environment jsdom */
import React from "react";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { PlanClarificationAnswers } from "../core/ui-state";
import { usePlanModeWorkflow } from "./use-plan-mode-workflow";

// React 19 tests require explicit act environment flag when using raw createRoot harnesses.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

interface HarnessProps {
  onReady: (value: ReturnType<typeof usePlanModeWorkflow>) => void;
  params: Parameters<typeof usePlanModeWorkflow>[0];
}

function HookHarness({ onReady, params }: HarnessProps) {
  const value = usePlanModeWorkflow(params);
  onReady(value);
  return null;
}

describe("usePlanModeWorkflow clarification answer updates", () => {
  let container: HTMLDivElement;
  let root: Root;
  let answers: PlanClarificationAnswers;
  let hookValue: ReturnType<typeof usePlanModeWorkflow> | null;

  const applyAnswersUpdate = (next: React.SetStateAction<PlanClarificationAnswers>) => {
    answers = typeof next === "function" ? next(answers) : next;
  };

  beforeEach(() => {
    container = document.createElement("div");
    root = createRoot(container);
    answers = {};
    hookValue = null;

    act(() => {
      root.render(
        <HookHarness
          onReady={(value) => {
            hookValue = value;
          }}
          params={{
            ai: undefined,
            busy: false,
            currentSessionId: null,
            planKnowledgeEnabled: false,
            planThreads: {},
            setPlanThreads: vi.fn(),
            pendingPlanLinkDecision: null,
            setPendingPlanLinkDecision: vi.fn(),
            pendingPlanClarification: null,
            setPendingPlanClarification: vi.fn(),
            planClarificationAnswers: answers,
            setPlanClarificationAnswers: applyAnswersUpdate,
            setPlanClarificationError: vi.fn(),
            setClarificationQuestionIndex: vi.fn(),
            pendingPlan: null,
            setPendingPlan: vi.fn(),
            setPlanning: vi.fn(),
            setRunningPhase: vi.fn(),
            setPlanRelationChecking: vi.fn(),
            planningTaskRef: { current: null },
            planningStopRequestedRef: { current: false },
            createSession: vi.fn(() => "s1"),
            addTask: vi.fn(() => "t1"),
            updateTask: vi.fn(),
            executeAgentTask: vi.fn(async () => undefined),
          }}
        />,
      );
    });
  });

  afterEach(() => {
    act(() => {
      root.unmount();
    });
  });

  it("single-select toggles selected option", () => {
    const question = {
      id: "q1",
      question: "语言偏好",
      options: ["A", "B"],
      multiSelect: false,
      required: true,
    };

    act(() => {
      hookValue!.handleSelectClarificationOption(question, "A");
    });
    expect(answers.q1?.selectedOptions).toEqual(["A"]);

    act(() => {
      hookValue!.handleSelectClarificationOption(question, "A");
    });
    expect(answers.q1?.selectedOptions).toEqual([]);
  });

  it("custom input clears single-select option", () => {
    answers = {
      q2: {
        selectedOptions: ["默认方案"],
      },
    };

    const question = {
      id: "q2",
      question: "补充说明",
      options: ["默认方案", "快速方案"],
      multiSelect: false,
      required: true,
    };

    act(() => {
      hookValue!.handleClarificationCustomInput(question, "自定义输入");
    });

    expect(answers.q2?.selectedOptions).toEqual([]);
    expect(answers.q2?.customInput).toBe("自定义输入");
  });
});
