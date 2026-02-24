import { useCallback, type Dispatch, type MutableRefObject, type SetStateAction } from "react";
import type { MToolsAI } from "@/core/plugin-system/plugin-interface";
import { useAgentStore } from "@/store/agent-store";
import {
  archivePlanThread,
  buildPlanRequestPolicy,
  createPlanThread,
  finalizePlanThreadDraft,
  markPlanThreadPhase,
  parsePlanFollowupDecision,
  revisePlanThreadWithRelatedFollowup,
  shouldEnablePlanKBByKeyword,
  type PlanFollowupRelation,
  type PlanThreadState,
} from "../core/plan-mode";
import {
  findFirstIncompleteClarificationIndex,
  parsePlanClarificationQuestions,
  type PendingPlanClarificationState,
  type PendingPlanLinkDecisionState,
  type PendingPlanState,
  type PlanClarificationAnswers,
  type PlanClarificationQuestion,
  type PlanRelationCheckingState,
  type RunningPhase,
} from "../core/ui-state";

type PlanRequestPolicy = ReturnType<typeof buildPlanRequestPolicy>;
type AgentStoreState = ReturnType<typeof useAgentStore.getState>;

interface UsePlanModeWorkflowParams {
  ai?: MToolsAI;
  busy: boolean;
  currentSessionId: string | null;
  planKnowledgeEnabled: boolean;
  planThreads: Record<string, PlanThreadState>;
  setPlanThreads: Dispatch<SetStateAction<Record<string, PlanThreadState>>>;
  pendingPlanLinkDecision: PendingPlanLinkDecisionState | null;
  setPendingPlanLinkDecision: Dispatch<
    SetStateAction<PendingPlanLinkDecisionState | null>
  >;
  pendingPlanClarification: PendingPlanClarificationState | null;
  setPendingPlanClarification: Dispatch<SetStateAction<PendingPlanClarificationState | null>>;
  planClarificationAnswers: PlanClarificationAnswers;
  setPlanClarificationAnswers: Dispatch<SetStateAction<PlanClarificationAnswers>>;
  setPlanClarificationError: Dispatch<SetStateAction<string | null>>;
  setClarificationQuestionIndex: Dispatch<SetStateAction<number>>;
  pendingPlan: PendingPlanState | null;
  setPendingPlan: Dispatch<SetStateAction<PendingPlanState | null>>;
  setPlanning: Dispatch<SetStateAction<boolean>>;
  setRunningPhase: Dispatch<SetStateAction<RunningPhase | null>>;
  setPlanRelationChecking: Dispatch<SetStateAction<PlanRelationCheckingState | null>>;
  planningTaskRef: MutableRefObject<{ sessionId: string; taskId: string } | null>;
  planningStopRequestedRef: MutableRefObject<boolean>;
  createSession: AgentStoreState["createSession"];
  addTask: AgentStoreState["addTask"];
  updateTask: AgentStoreState["updateTask"];
  executeAgentTask: (
    query: string,
    opts?: {
      sessionId?: string;
      taskId?: string;
    },
  ) => Promise<void>;
}

interface UsePlanModeWorkflowResult {
  runPlanWorkflow: (
    query: string,
    opts?: {
      forcedRelation?: PlanFollowupRelation;
      forcedSessionId?: string;
    },
  ) => Promise<void>;
  handleSelectClarificationOption: (
    question: PlanClarificationQuestion,
    option: string,
  ) => void;
  handleClarificationCustomInput: (
    question: PlanClarificationQuestion,
    value: string,
  ) => void;
  handleSubmitPlanClarification: () => Promise<void>;
  handleCancelPlanClarification: () => void;
  handleExecutePlan: () => Promise<void>;
  handleCancelPlan: () => void;
  handleResolvePlanLinkDecision: (
    relation: Exclude<PlanFollowupRelation, "uncertain">,
  ) => Promise<void>;
}

export function usePlanModeWorkflow(
  params: UsePlanModeWorkflowParams,
): UsePlanModeWorkflowResult {
  const {
    ai,
    busy,
    currentSessionId,
    planKnowledgeEnabled,
    planThreads,
    setPlanThreads,
    pendingPlanLinkDecision,
    setPendingPlanLinkDecision,
    pendingPlanClarification,
    setPendingPlanClarification,
    planClarificationAnswers,
    setPlanClarificationAnswers,
    setPlanClarificationError,
    setClarificationQuestionIndex,
    pendingPlan,
    setPendingPlan,
    setPlanning,
    setRunningPhase,
    setPlanRelationChecking,
    planningTaskRef,
    planningStopRequestedRef,
    createSession,
    addTask,
    updateTask,
    executeAgentTask,
  } = params;

  const resolvePlanRequestPolicy = useCallback(
    (query: string) => {
      const keywordHit = shouldEnablePlanKBByKeyword(query);
      const effectivePlanKB = planKnowledgeEnabled || keywordHit;
      return {
        keywordHit,
        effectivePlanKB,
        requestPolicy: buildPlanRequestPolicy(effectivePlanKB),
      };
    },
    [planKnowledgeEnabled],
  );

  const requestPlanClarification = useCallback(
    async (opts: {
      sessionId: string;
      taskId: string;
      query: string;
      requestPolicy: PlanRequestPolicy;
    }): Promise<PlanClarificationQuestion[]> => {
      if (!ai) return [];
      const { sessionId, taskId, query, requestPolicy } = opts;
      const messages = [
        {
          role: "system" as const,
          content:
            [
              "你是任务澄清助手。判断是否需要在执行前先补充信息。",
              "如果不需要，输出 JSON: {\"needs_clarification\":false,\"questions\":[]}",
              "如果需要，输出 JSON: {\"needs_clarification\":true,\"questions\":[...]}",
              "questions 每项字段：",
              "- id: 字符串",
              "- question: 问题文本",
              "- options: 选项数组（2-5 个短句）",
              "- multi_select: 是否多选（布尔，默认 false）",
              "- required: 是否必填（布尔，默认 true）",
              "- placeholder: 输入提示文案（可选）",
              "不要在 options 中写“其他/自定义输入”，界面会自动追加自定义输入。",
              "仅输出 JSON，不要 Markdown，不要解释。",
            ].join("\n"),
        },
        { role: "user" as const, content: query },
      ];

      let raw = "";
      try {
        await ai.stream({
          messages,
          requestPolicy,
          onChunk: (chunk) => {
            raw += chunk;
            const rendered = raw.trim() || "正在生成澄清问题...";
            updateTask(sessionId, taskId, {
              status: "running",
              steps: [
                {
                  type: "thought",
                  content: `澄清分析中:\n${rendered}`,
                  timestamp: Date.now(),
                  streaming: true,
                },
              ],
              answer: "正在规划中...",
              last_error: undefined,
            });
          },
        });
      } catch {
        const resp = await ai.chat({
          messages,
          temperature: 0.2,
          requestPolicy,
        });
        raw = resp.content || "";
      }

      const finalized = raw.trim();
      if (finalized) {
        updateTask(sessionId, taskId, {
          status: "running",
          steps: [
            {
              type: "thought",
              content: `澄清分析结果:\n${finalized}`,
              timestamp: Date.now(),
            },
          ],
          answer: "正在规划中...",
          last_error: undefined,
        });
      }
      return parsePlanClarificationQuestions(finalized);
    },
    [ai, updateTask],
  );

  const classifyPlanFollowup = useCallback(
    async (thread: PlanThreadState, query: string) => {
      if (!ai) return { relation: "uncertain" as PlanFollowupRelation };
      const messages = [
        {
          role: "system" as const,
          content:
            [
              "你是计划关联分类器。",
              "判断新输入是否应基于既有计划继续完善，还是应创建新计划。",
              "输出 JSON：",
              "{\"relation\":\"related|unrelated|uncertain\",\"reason\":\"简要原因\"}",
              "仅输出 JSON，不要额外解释。",
            ].join("\n"),
        },
        {
          role: "user" as const,
          content: `当前计划任务：\n${thread.baseQuery}\n\n当前计划草案：\n${thread.latestPlan || "(暂无)"}\n\n用户新输入：\n${query}`,
        },
      ];

      let raw = "";
      setPlanRelationChecking({
        sessionId: thread.sessionId,
        content: "正在判断是否关联当前计划...",
        streaming: true,
      });
      try {
        await ai.stream({
          messages,
          requestPolicy: {
            ragMode: "off",
            forceProductRag: "off",
          },
          onChunk: (chunk) => {
            raw += chunk;
            setPlanRelationChecking({
              sessionId: thread.sessionId,
              content: raw.trim() || "正在判断是否关联当前计划...",
              streaming: true,
            });
          },
        });
      } catch {
        const resp = await ai.chat({
          messages,
          temperature: 0.1,
          requestPolicy: {
            ragMode: "off",
            forceProductRag: "off",
          },
        });
        raw = resp.content || "";
      }

      return parsePlanFollowupDecision(raw.trim());
    },
    [ai, setPlanRelationChecking],
  );

  const streamPlanDraft = useCallback(
    async (opts: {
      sessionId: string;
      taskId: string;
      userPrompt: string;
      clarificationSummary?: string;
      requestPolicy: PlanRequestPolicy;
    }) => {
      if (!ai) return "未生成有效计划。";
      const { sessionId, taskId, userPrompt, clarificationSummary, requestPolicy } =
        opts;
      let streamedPlan = "";
      const summaryPrefix = clarificationSummary?.trim()
        ? `澄清结果:\n${clarificationSummary.trim()}\n\n`
        : "";

      planningStopRequestedRef.current = false;
      planningTaskRef.current = { sessionId, taskId };

      await ai.stream({
        messages: [
          {
            role: "system",
            content:
              "你是执行型 Agent。请先给出执行计划，不要调用工具，不要直接执行。请输出简洁分步计划（Markdown 列表）。",
          },
          { role: "user", content: userPrompt },
        ],
        requestPolicy,
        onChunk: (chunk) => {
          streamedPlan += chunk;
          const rendered = streamedPlan.trim() || "正在规划...";
          updateTask(sessionId, taskId, {
            status: "running",
            retry_count: 0,
            steps: [
              {
                type: "thought",
                content: `${summaryPrefix}计划草案:\n${rendered}`,
                timestamp: Date.now(),
                streaming: true,
              },
            ],
            answer: "正在规划中...",
            last_error: undefined,
          });
        },
      });

      if (planningStopRequestedRef.current) {
        throw new Error("PlanningAborted");
      }

      const finalizedPlan = streamedPlan.trim() || "未生成有效计划。";
      updateTask(sessionId, taskId, {
        status: "pending",
        retry_count: 0,
        steps: [
          {
            type: "thought",
            content: `${summaryPrefix}计划草案:\n${finalizedPlan}`,
            timestamp: Date.now(),
          },
        ],
        answer: "计划已生成，请确认后执行。",
        last_error: undefined,
      });

      return finalizedPlan;
    },
    [ai, planningStopRequestedRef, planningTaskRef, updateTask],
  );

  const runPlanWorkflow = useCallback(
    async (
      query: string,
      opts?: {
        forcedRelation?: PlanFollowupRelation;
        forcedSessionId?: string;
      },
    ) => {
      if (!ai || !query.trim()) return;

      const { requestPolicy } = resolvePlanRequestPolicy(query);
      let sessionId = opts?.forcedSessionId || currentSessionId;
      let createdSessionNow = false;
      let relation: PlanFollowupRelation = opts?.forcedRelation || "unrelated";
      const existingThread =
        sessionId && planThreads[sessionId] && planThreads[sessionId].phase !== "archived"
          ? planThreads[sessionId]
          : null;

      setPlanning(true);
      setRunningPhase("planning");
      planningStopRequestedRef.current = false;
      setPendingPlanLinkDecision(null);
      setPlanRelationChecking(null);

      try {
        if (!sessionId) {
          sessionId = createSession(query);
          createdSessionNow = true;
        }
        if (!sessionId) return;

        if (!opts?.forcedRelation && existingThread) {
          const classify = await classifyPlanFollowup(existingThread, query);
          setPlanRelationChecking(null);
          relation = classify.relation;
          if (relation === "uncertain") {
            setPendingPlanLinkDecision({
              sessionId,
              query,
              reason: classify.reason,
            });
            return;
          }
        }

        let taskId = "";
        let planThread: PlanThreadState | null = null;
        const currentSessionSnapshot = useAgentStore
          .getState()
          .sessions.find((s) => s.id === sessionId);

        if (
          relation === "related" &&
          existingThread &&
          currentSessionSnapshot?.tasks.some((task) => task.id === existingThread.taskId)
        ) {
          taskId = existingThread.taskId;
          planThread = revisePlanThreadWithRelatedFollowup(existingThread, query);
          setPlanThreads((prev) => ({
            ...prev,
            [sessionId!]: planThread!,
          }));
        } else {
          relation = "unrelated";
          if (existingThread) {
            const archived = archivePlanThread(existingThread);
            setPlanThreads((prev) => ({
              ...prev,
              [sessionId!]: archived,
            }));
            const archivedTask = useAgentStore
              .getState()
              .sessions.find((s) => s.id === sessionId)
              ?.tasks.find((task) => task.id === existingThread.taskId);
            if (archivedTask) {
              updateTask(sessionId, existingThread.taskId, {
                steps: [
                  ...archivedTask.steps,
                  {
                    type: "thought",
                    content: "旧计划线程已归档，后续输入将使用新线程规划。",
                    timestamp: Date.now(),
                  },
                ],
              });
            }
          }

          if (createdSessionNow) {
            const created = useAgentStore
              .getState()
              .sessions.find((s) => s.id === sessionId);
            taskId = created?.tasks[0]?.id || "";
          } else {
            taskId = addTask(sessionId, query);
          }
          if (!taskId) return;

          planThread = createPlanThread({
            sessionId,
            taskId,
            baseQuery: query,
          });
          setPlanThreads((prev) => ({
            ...prev,
            [sessionId!]: planThread!,
          }));
        }

        if (!taskId || !planThread) return;

        planningTaskRef.current = { sessionId, taskId };
        updateTask(sessionId, taskId, {
          status: "running",
          retry_count: 0,
          answer:
            relation === "related"
              ? `正在完善既有计划（v${planThread.planVersion}）...`
              : "正在分析需求并生成计划...",
          last_error: undefined,
        });

        const clarificationQuestions = await requestPlanClarification({
          sessionId,
          taskId,
          query,
          requestPolicy,
        });

        if (clarificationQuestions.length > 0) {
          const questionLines = clarificationQuestions
            .map((item, idx) => {
              return `${idx + 1}. ${item.question}${item.multiSelect ? "（多选）" : "（单选）"}${item.required ? "（必填）" : "（选填）"}`;
            })
            .join("\n");

          setPlanThreads((prev) => ({
            ...prev,
            [sessionId!]: markPlanThreadPhase(planThread!, "clarifying"),
          }));
          updateTask(sessionId, taskId, {
            status: "pending",
            retry_count: 0,
            steps: [
              {
                type: "thought",
                content: `计划前需要补充信息，请先回答以下问题：\n${questionLines}`,
                timestamp: Date.now(),
              },
            ],
            answer: "请先完成澄清问题，提交后继续生成计划。",
            last_error: undefined,
          });
          setPendingPlanClarification({
            sessionId,
            taskId,
            query,
            questions: clarificationQuestions,
            direction: relation === "related" ? "linked" : "new",
          });
          setClarificationQuestionIndex(0);
          return;
        }

        const userPrompt =
          relation === "related" && existingThread
            ? `原始目标:\n${planThread.baseQuery}\n\n当前计划(v${Math.max(1, planThread.planVersion - 1)}):\n${existingThread.latestPlan || "(暂无计划)"}\n\n新增要求:\n${query}\n\n请先给出“变更摘要”，再输出完整重写后的执行计划（Markdown 列表），不要执行。`
            : query;

        const plan = await streamPlanDraft({
          sessionId,
          taskId,
          userPrompt,
          requestPolicy,
        });

        const finalizedThread = finalizePlanThreadDraft(planThread, plan);
        setPlanThreads((prev) => ({
          ...prev,
          [sessionId!]: finalizedThread,
        }));
        setPendingPlan({
          sessionId,
          taskId,
          query:
            relation === "related"
              ? `${planThread.baseQuery}\n\n[新增要求]\n${query}`
              : query,
          plan,
          version: finalizedThread.planVersion,
          sourceTaskId:
            relation === "related" ? finalizedThread.relationSourceTaskId : undefined,
          recentFollowup:
            relation === "related" ? finalizedThread.latestFollowup : undefined,
        });
      } catch (e) {
        const errMsg = e instanceof Error ? e.message : String(e);
        const planningTask = planningTaskRef.current;
        if (planningTask) {
          if (errMsg === "PlanningAborted") {
            updateTask(planningTask.sessionId, planningTask.taskId, {
              status: "cancelled",
              answer: "计划生成已停止。",
            });
          } else {
            updateTask(planningTask.sessionId, planningTask.taskId, {
              status: "error",
              answer: `计划生成失败: ${e}`,
              last_error: String(e),
            });
          }
        }
      } finally {
        setPlanning(false);
        setRunningPhase((prev) => (prev === "planning" ? null : prev));
        planningTaskRef.current = null;
        setPlanRelationChecking(null);
      }
    },
    [
      ai,
      resolvePlanRequestPolicy,
      currentSessionId,
      planThreads,
      createSession,
      classifyPlanFollowup,
      updateTask,
      addTask,
      requestPlanClarification,
      streamPlanDraft,
      setPlanning,
      setRunningPhase,
      planningStopRequestedRef,
      setPendingPlanLinkDecision,
      setPlanRelationChecking,
      setPlanThreads,
      setPendingPlanClarification,
      setClarificationQuestionIndex,
      setPendingPlan,
      planningTaskRef,
    ],
  );

  const handleSelectClarificationOption = useCallback(
    (question: PlanClarificationQuestion, option: string) => {
      setPlanClarificationError(null);
      setPlanClarificationAnswers((prev) => ({
        ...prev,
        [question.id]: (() => {
          const prevAnswer = prev[question.id] || {};
          const prevSelected = prevAnswer.selectedOptions || [];
          if (question.multiSelect) {
            const nextSelected = prevSelected.includes(option)
              ? prevSelected.filter((item) => item !== option)
              : [...prevSelected, option];
            return {
              ...prevAnswer,
              selectedOptions: nextSelected,
            };
          }

          const isSame = prevSelected.length === 1 && prevSelected[0] === option;
          return {
            selectedOptions: isSame ? [] : [option],
            customInput: undefined,
          };
        })(),
      }));
    },
    [setPlanClarificationError, setPlanClarificationAnswers],
  );

  const handleClarificationCustomInput = useCallback(
    (question: PlanClarificationQuestion, value: string) => {
      setPlanClarificationError(null);
      setPlanClarificationAnswers((prev) => {
        const prevAnswer = prev[question.id] || {};
        const nextSelected =
          !question.multiSelect && value.trim() ? [] : prevAnswer.selectedOptions || [];
        return {
          ...prev,
          [question.id]: {
            ...prevAnswer,
            selectedOptions: nextSelected,
            customInput: value,
          },
        };
      });
    },
    [setPlanClarificationError, setPlanClarificationAnswers],
  );

  const handleSubmitPlanClarification = useCallback(async () => {
    if (!pendingPlanClarification || busy) return;
    const { sessionId, taskId, query, questions, direction } = pendingPlanClarification;

    const firstIncompleteIndex = findFirstIncompleteClarificationIndex(
      questions,
      planClarificationAnswers,
    );
    if (firstIncompleteIndex >= 0) {
      setClarificationQuestionIndex(firstIncompleteIndex);
      setPlanClarificationError(
        `请先补充问题：${questions[firstIncompleteIndex]?.question || "未完成问题"}`,
      );
      return;
    }

    const summaryLines: string[] = [];
    for (const question of questions) {
      const answer = planClarificationAnswers[question.id];
      const selected = (answer?.selectedOptions || []).filter((option) => !!option);
      const custom = answer?.customInput?.trim() || "";
      if (selected.length === 0 && !custom) continue;

      const parts: string[] = [];
      if (selected.length > 0) {
        parts.push(`选项: ${selected.join(" / ")}`);
      }
      if (custom) {
        parts.push(`自定义: ${custom}`);
      }
      summaryLines.push(`- ${question.question}: ${parts.join("；")}`);
    }

    setPlanning(true);
    setRunningPhase("planning");
    planningStopRequestedRef.current = false;
    planningTaskRef.current = { sessionId, taskId };
    setPlanClarificationError(null);
    try {
      const { requestPolicy } = resolvePlanRequestPolicy(query);
      const summary = summaryLines.length > 0 ? summaryLines.join("\n") : "- 无额外补充信息";
      const currentThread = planThreads[sessionId];
      const relatedWithHistory = direction === "linked" && !!currentThread?.latestPlan;
      const userPrompt = relatedWithHistory
        ? `原始目标:\n${currentThread.baseQuery}\n\n当前计划(v${Math.max(1, currentThread.planVersion - 1)}):\n${currentThread.latestPlan}\n\n新增要求:\n${query}\n\n补充信息:\n${summary}\n\n请先给出“变更摘要”，再输出完整重写后的执行计划（Markdown 列表），不要执行。`
        : `用户目标:\n${query}\n\n补充信息:\n${summary}\n\n请基于以上信息输出简洁可执行计划（Markdown 列表），不要调用工具，不要执行。`;

      const plan = await streamPlanDraft({
        sessionId,
        taskId,
        userPrompt,
        clarificationSummary: summary,
        requestPolicy,
      });
      const baseThread =
        currentThread ||
        createPlanThread({
          sessionId,
          taskId,
          baseQuery: query,
        });
      const finalizedThread = finalizePlanThreadDraft(baseThread, plan);
      setPlanThreads((prev) => ({
        ...prev,
        [sessionId]: finalizedThread,
      }));
      setPendingPlanClarification(null);
      setPlanClarificationAnswers({});
      setClarificationQuestionIndex(0);
      setPendingPlan({
        sessionId,
        taskId,
        query:
          direction === "linked"
            ? `${finalizedThread.baseQuery}\n\n[新增要求]\n${query}`
            : query,
        plan,
        version: finalizedThread.planVersion,
        sourceTaskId: direction === "linked" ? finalizedThread.relationSourceTaskId : undefined,
        recentFollowup: direction === "linked" ? finalizedThread.latestFollowup : undefined,
      });
    } catch (e) {
      const errMsg = e instanceof Error ? e.message : String(e);
      if (errMsg === "PlanningAborted") {
        updateTask(sessionId, taskId, {
          status: "cancelled",
          answer: "计划生成已停止。",
        });
      } else {
        updateTask(sessionId, taskId, {
          status: "error",
          answer: `计划生成失败: ${e}`,
          last_error: String(e),
        });
      }
    } finally {
      setPlanning(false);
      setRunningPhase((prev) => (prev === "planning" ? null : prev));
      planningTaskRef.current = null;
    }
  }, [
    pendingPlanClarification,
    busy,
    planClarificationAnswers,
    setClarificationQuestionIndex,
    setPlanClarificationError,
    setPlanning,
    setRunningPhase,
    planningStopRequestedRef,
    planningTaskRef,
    resolvePlanRequestPolicy,
    planThreads,
    streamPlanDraft,
    setPlanThreads,
    setPendingPlanClarification,
    setPlanClarificationAnswers,
    setPendingPlan,
    updateTask,
  ]);

  const handleCancelPlanClarification = useCallback(() => {
    if (!pendingPlanClarification) return;
    updateTask(pendingPlanClarification.sessionId, pendingPlanClarification.taskId, {
      status: "cancelled",
      answer: "计划澄清已取消，未执行。",
    });
    setPlanThreads((prev) => {
      const thread = prev[pendingPlanClarification.sessionId];
      if (!thread) return prev;
      return {
        ...prev,
        [pendingPlanClarification.sessionId]: archivePlanThread(thread),
      };
    });
    setPendingPlanClarification(null);
    setPlanClarificationAnswers({});
    setPlanClarificationError(null);
    setClarificationQuestionIndex(0);
  }, [
    pendingPlanClarification,
    updateTask,
    setPlanThreads,
    setPendingPlanClarification,
    setPlanClarificationAnswers,
    setPlanClarificationError,
    setClarificationQuestionIndex,
  ]);

  const handleExecutePlan = useCallback(async () => {
    if (!pendingPlan || busy) return;
    const draft = pendingPlan;
    setPlanThreads((prev) => {
      const thread = prev[draft.sessionId];
      if (!thread) return prev;
      return {
        ...prev,
        [draft.sessionId]: markPlanThreadPhase(thread, "executing"),
      };
    });
    setPendingPlan(null);
    await executeAgentTask(draft.query, {
      sessionId: draft.sessionId,
      taskId: draft.taskId,
    });
    setPlanThreads((prev) => {
      const thread = prev[draft.sessionId];
      if (!thread) return prev;
      return {
        ...prev,
        [draft.sessionId]: markPlanThreadPhase(thread, "awaiting_confirm"),
      };
    });
  }, [pendingPlan, busy, setPlanThreads, setPendingPlan, executeAgentTask]);

  const handleCancelPlan = useCallback(() => {
    if (!pendingPlan) return;
    updateTask(pendingPlan.sessionId, pendingPlan.taskId, {
      status: "cancelled",
      answer: "计划已取消，未执行。",
    });
    setPlanThreads((prev) => {
      const thread = prev[pendingPlan.sessionId];
      if (!thread) return prev;
      return {
        ...prev,
        [pendingPlan.sessionId]: archivePlanThread(thread),
      };
    });
    setPendingPlanClarification(null);
    setPlanClarificationAnswers({});
    setPlanClarificationError(null);
    setClarificationQuestionIndex(0);
    setPendingPlan(null);
  }, [
    pendingPlan,
    updateTask,
    setPlanThreads,
    setPendingPlanClarification,
    setPlanClarificationAnswers,
    setPlanClarificationError,
    setClarificationQuestionIndex,
    setPendingPlan,
  ]);

  const handleResolvePlanLinkDecision = useCallback(
    async (relation: Exclude<PlanFollowupRelation, "uncertain">) => {
      if (!pendingPlanLinkDecision || busy) return;
      const draft = pendingPlanLinkDecision;
      setPendingPlanLinkDecision(null);
      setPlanRelationChecking(null);
      await runPlanWorkflow(draft.query, {
        forcedRelation: relation,
        forcedSessionId: draft.sessionId,
      });
    },
    [
      pendingPlanLinkDecision,
      busy,
      setPendingPlanLinkDecision,
      setPlanRelationChecking,
      runPlanWorkflow,
    ],
  );

  return {
    runPlanWorkflow,
    handleSelectClarificationOption,
    handleClarificationCustomInput,
    handleSubmitPlanClarification,
    handleCancelPlanClarification,
    handleExecutePlan,
    handleCancelPlan,
    handleResolvePlanLinkDecision,
  };
}
