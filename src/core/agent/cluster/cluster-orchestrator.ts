import { getMToolsAI, chatDirect } from "@/core/ai/mtools-ai";
import type { AgentStep } from "@/plugins/builtin/SmartAgent/core/react-agent";
import { ROLE_PLANNER, ROLE_REVIEWER, getRoleById as getPresetRole } from "./preset-roles";
import { getRoleById as getAsyncRole } from "./agent-role";
import { LocalAgentBridge, type ConfirmDangerousAction, type AskUserCallback } from "./local-agent-bridge";
import { ClusterMessageBus } from "./message-bus";
import { createClusterPlan, topologicalSort, validatePlan } from "./cluster-plan";
import {
  getClusterAggregateBudgets,
  getClusterPlannerCodingHint,
  getClusterStepCodingHint,
  getEnhancedClusterRoleIterations,
} from "@/core/agent/coding-profile";
import {
  assembleAgentExecutionContext,
  buildAgentExecutionContextPlan,
  collectContextPathHints,
} from "@/core/agent/context-runtime";
import type {
  AgentBridge,
  AgentInstance,
  ClusterMode,
  ClusterPlan,
  ClusterResult,
  ClusterSessionStatus,
  ClusterStep,
  ReviewFeedback,
  ClusterProgressEvent,
  ClusterProgressEventType,
  ModelRoutingConfig,
  PlanApprovalRequest,
} from "./types";
import { useAIStore } from "@/store/ai-store";
import { modelSupportsImageInput } from "@/core/ai/model-capabilities";
import { buildAssistantSupplementalPrompt } from "@/core/ai/assistant-config";

const CLUSTER_EXECUTION_TIMEOUT_MS = 1_800_000; // 30 minutes
const STEP_EXECUTION_TIMEOUT_MS = 300_000; // 5 minutes per step
const STEP_EXECUTION_TIMEOUT_OPENCLAW_MS = 600_000; // 10 minutes per step

const CODING_PLAN_GATE_RE = /Coding Plan.*only available|only available.*Coding/i;

/**
 * Retry wrapper for ai.chat calls — handles transient network / decoding errors.
 * When the API gateway blocks with "Coding Plan" error, auto-falls back to
 * chatDirect (direct fetch, no Rust tool injection) to bypass the restriction.
 */
async function retryChat(
  ai: ReturnType<typeof getMToolsAI>,
  params: Parameters<ReturnType<typeof getMToolsAI>["chat"]>[0],
  signal?: AbortSignal,
  maxRetries?: number,
): Promise<{ content: string }> {
  const TRANSIENT_RE = /decoding|network|econnreset|timeout|stream|fetch/i;
  const aiConfig = useAIStore.getState().config;
  const resolvedMaxRetries = Math.max(
    0,
    Math.min(10, maxRetries ?? aiConfig.agent_retry_max ?? 3),
  );
  const baseDelayMs = Math.max(
    500,
    Math.min(60000, aiConfig.agent_retry_backoff_ms ?? 5000),
  );
  let lastError: unknown;
  for (let attempt = 0; attempt <= resolvedMaxRetries; attempt++) {
    if (signal?.aborted) throw new Error("Aborted");
    try {
      return await ai.chat(params);
    } catch (err: unknown) {
      lastError = err;
      if (signal?.aborted) throw err;
      const msg = err instanceof Error ? err.message : String(err);

      if (CODING_PLAN_GATE_RE.test(msg)) {
        console.warn("[Cluster] API gateway blocked 'Coding Plan', falling back to chatDirect");
        return await chatDirect({
          mode: "cluster",
          messages: params.messages.map((m) => ({
            role: m.role,
            content: m.content,
            ...(m.images?.length ? { images: m.images } : {}),
          })),
          model: params.model,
          temperature: params.temperature,
          signal: params.signal,
        });
      }

      if (!TRANSIENT_RE.test(msg) || attempt === resolvedMaxRetries) throw err;
      const delay = baseDelayMs * 2 ** attempt;
      await new Promise((r) => setTimeout(r, delay));
    }
  }
  throw lastError;
}

export interface ClusterOrchestratorOptions {
  maxConcurrency?: number;
  signal?: AbortSignal;
  workspaceRoot?: string;
  /** 全局执行超时（ms），默认 1800s */
  timeoutMs?: number;
  onStatusChange?: (status: ClusterSessionStatus) => void;
  onInstanceUpdate?: (instance: AgentInstance) => void;
  onStep?: (instanceId: string, step: AgentStep) => void;
  onProgress?: (event: ClusterProgressEvent) => void;
  onPlanApproval?: (request: PlanApprovalRequest) => Promise<PlanApprovalRequest>;
  /** 危险操作确认回调 */
  confirmDangerousAction?: ConfirmDangerousAction;
  /** 向用户提问回调（集群中的 Agent 可通过此回调与用户交互） */
  askUser?: AskUserCallback;
  modelRouting?: ModelRoutingConfig;
  maxReviewRetries?: number;
  autoReviewCodeSteps?: boolean;
  codingMode?: boolean;
  largeProjectMode?: boolean;
  openClawMode?: boolean;
}

/**
 * Agent Cluster 编排器。
 *
 * 执行流程：
 * 1. Plan Phase       — Planner Agent 分析用户输入，生成 ClusterPlan（DAG）
 * 2. Approval Phase   — (可选) Human-in-the-Loop 审批计划
 * 3. Dispatch Phase   — 按拓扑排序逐层并行分发给角色 Agent
 * 4. Review Phase     — (可选) Reviewer Agent 审核结果，驱动 Fix 循环
 * 5. Aggregate Phase  — 汇总所有 Agent 结果，生成最终答案
 */
export class ClusterOrchestrator {
  private messageBus = new ClusterMessageBus();
  private instances = new Map<string, AgentInstance>();
  private bridges = new Map<string, AgentBridge>();
  private remoteBridges = new Map<string, AgentBridge>();
  private status: ClusterSessionStatus = "idle";
  private options: ClusterOrchestratorOptions;
  private internalAbort = new AbortController();
  private stepUpdateTimers = new Map<string, ReturnType<typeof setTimeout>>();
  private runImages: string[] | undefined;
  private projectContext: string | undefined;

  constructor(options: ClusterOrchestratorOptions = {}) {
    this.options = options;
    if (options.signal) {
      if (options.signal.aborted) {
        this.internalAbort.abort(options.signal.reason);
      } else {
        options.signal.addEventListener(
          "abort",
          () => this.internalAbort.abort(options.signal!.reason),
          { once: true },
        );
      }
    }
  }

  /** Combined signal: aborts on external signal OR internal timeout/abort. */
  private get signal(): AbortSignal {
    return this.internalAbort.signal;
  }

  registerRemoteBridge(roleId: string, bridge: AgentBridge): void {
    this.remoteBridges.set(roleId, bridge);
  }

  unregisterRemoteBridge(roleId: string): void {
    this.remoteBridges.delete(roleId);
  }

  getRemoteBridges(): Map<string, AgentBridge> {
    return new Map(this.remoteBridges);
  }

  getMessageBus(): ClusterMessageBus {
    return this.messageBus;
  }

  getInstances(): AgentInstance[] {
    return [...this.instances.values()];
  }

  getStatus(): ClusterSessionStatus {
    return this.status;
  }

  private setStatus(status: ClusterSessionStatus) {
    this.status = status;
    this.options.onStatusChange?.(status);
  }

  private emitProgress(type: ClusterProgressEventType, detail?: unknown, stepId?: string, instanceId?: string) {
    this.options.onProgress?.({
      type,
      timestamp: Date.now(),
      stepId,
      instanceId,
      detail,
    });
  }

  private updateInstance(id: string, patch: Partial<AgentInstance>) {
    const current = this.instances.get(id);
    if (!current) return;
    const updated = { ...current, ...patch };
    this.instances.set(id, updated);
    this.options.onInstanceUpdate?.(updated);
  }

  setProjectContext(context: string | undefined): void {
    this.projectContext = context;
  }

  private async buildChatRuntimeContext(query: string): Promise<{
    systemPromptBlock?: string;
    contextMessages: Array<{ role: "user" | "assistant"; content: string }>;
    effectiveWorkspaceRoot?: string;
  }> {
    const config = useAIStore.getState().config;
    const projectPathHints = collectContextPathHints(this.projectContext);
    const attachmentSummary = [
      projectPathHints.length > 0 ? `路径线索 ${projectPathHints.length} 项` : "",
      this.runImages?.length ? `图片 ${this.runImages.length} 张` : "",
    ].filter(Boolean).join("，") || undefined;
    const executionContextPlan = await buildAgentExecutionContextPlan({
      query,
      explicitWorkspaceRoot: this.options.workspaceRoot,
      attachmentPaths: projectPathHints,
      images: this.runImages,
    });
    const assembledContext = await assembleAgentExecutionContext({
      query,
      executionContextPlan,
      attachmentSummary,
      systemHint: this.projectContext,
      supplementalSystemPrompt: buildAssistantSupplementalPrompt(config.system_prompt),
    });

    return {
      systemPromptBlock: assembledContext.extraSystemPrompt,
      contextMessages: assembledContext.sessionContextMessages,
      effectiveWorkspaceRoot: assembledContext.effectiveWorkspaceRoot,
    };
  }

  async execute(
    query: string,
    mode?: ClusterMode,
    images?: string[],
  ): Promise<ClusterResult> {
    const startTime = Date.now();
    this.runImages = images?.length ? images : undefined;
    this.messageBus.clear();
    this.instances.clear();
    this.bridges.clear();

    const timeoutMs = this.options.timeoutMs ?? CLUSTER_EXECUTION_TIMEOUT_MS;
    const timeoutId = setTimeout(() => {
      this.internalAbort.abort("执行超时");
      this.abortBridges();
    }, timeoutMs);

    try {
      // 1. Plan
      this.setStatus("planning");
      let plan = await this.planPhase(query, mode);
      this.emitProgress("plan_created", { plan });

      // 2. Approval (Human-in-the-Loop)
      if (this.options.onPlanApproval) {
        this.setStatus("awaiting_approval");
        const approvalResult = await this.approvalPhase(plan);
        if (approvalResult.status === "rejected") {
          this.setStatus("done");
          const rejectionReason = approvalResult.reason?.trim() || "用户取消了执行计划。";
          return {
            planId: plan.id,
            mode: plan.mode,
            finalAnswer: rejectionReason,
            agentInstances: [],
            totalDurationMs: Date.now() - startTime,
          };
        }
        if (approvalResult.status === "modified" && approvalResult.modifiedPlan) {
          const modErrors = validatePlan(approvalResult.modifiedPlan);
          if (modErrors.length > 0) {
            throw new Error(`修改后的计划验证失败:\n${modErrors.join("\n")}`);
          }
          plan = approvalResult.modifiedPlan;
        }
        this.emitProgress("plan_approved", { plan });
      }

      // 3. Dispatch & Execute (with Review-Fix loops)
      this.setStatus("dispatching");
      await this.dispatchPhase(plan);

      // 4. Aggregate
      this.flushStepUpdates();
      this.setStatus("aggregating");
      this.emitProgress("aggregation_started");
      const finalAnswer = await this.aggregatePhase(query, plan);

      clearTimeout(timeoutId);
      this.setStatus("done");
      this.emitProgress("cluster_done", { finalAnswer });
      return {
        planId: plan.id,
        mode: plan.mode,
        finalAnswer,
        agentInstances: this.getInstances(),
        totalDurationMs: Date.now() - startTime,
      };
    } catch (e) {
      clearTimeout(timeoutId);
      this.flushStepUpdates();
      this.setStatus("error");
      const error = e instanceof Error ? e.message : String(e);
      this.emitProgress("cluster_error", { error });
      return {
        planId: "error",
        mode: mode ?? "parallel_split",
        finalAnswer: `集群执行失败: ${error}`,
        agentInstances: this.getInstances(),
        totalDurationMs: Date.now() - startTime,
      };
    }
  }

  // ── Plan Phase ──

  private async planPhase(
    query: string,
    forceMode?: ClusterMode,
  ): Promise<ClusterPlan> {
    const ai = getMToolsAI("cluster");

    const autoReview = this.options.autoReviewCodeSteps ?? false;
    const reviewHint = autoReview
      ? "\n- 对于 coder 角色的步骤，设置 reviewAfter: true 以启用自动代码审查"
      : "";
    const codingPlannerHint = getClusterPlannerCodingHint({
      codingMode: this.options.codingMode,
      largeProjectMode: this.options.largeProjectMode,
      openClawMode: this.options.openClawMode,
    });

    const plannerSupportsImageInput = this.supportsImageInput(this.resolveModel("planner"));
    const imageHint = this.runImages?.length
      ? plannerSupportsImageInput
        ? `\n\n注意：用户已附带 ${this.runImages.length} 张图片，这些图片会自动传递给每个执行步骤的 Agent，无需再通过工具去寻找或获取图片，也不要对图片路径调用 read_file / read_file_range。请在规划时考虑这些已有图片。`
        : `\n\n注意：用户已附带 ${this.runImages.length} 张图片，但当前规划模型不支持直接识别图片内容。请不要假装已经看到了图片细节，而是基于已有文字描述/上下文规划，并在必要时提示应切换到支持视觉输入的模型或先补充 OCR / 文字描述。`
      : "";
    const chatRuntimeContext = await this.buildChatRuntimeContext(query);
    const plannerSystemPrompt = [
      ROLE_PLANNER.systemPrompt,
      reviewHint.trim(),
      codingPlannerHint.trim(),
      forceMode
        ? `强制使用模式: ${forceMode}`
        : "根据任务复杂度自动选择 multi_role 或 parallel_split 模式。",
      "只返回 JSON，不要附加其他内容。",
      chatRuntimeContext.systemPromptBlock || "",
    ]
      .filter((block): block is string => typeof block === "string" && block.trim().length > 0)
      .join("\n\n");

    const projectBlock = this.projectContext ? `\n\n## 项目上下文\n${this.projectContext}` : "";
    const plannerUserPrompt = `用户任务: ${query}${imageHint}${projectBlock}

请分析任务并返回 JSON 执行计划。`;

    const modelOverride = this.resolveModel("planner");
    const chatParams = {
      messages: [
        { role: "system" as const, content: plannerSystemPrompt },
        ...chatRuntimeContext.contextMessages,
        { role: "user" as const, content: plannerUserPrompt, ...(this.runImages?.length ? { images: this.runImages } : {}) },
      ],
      temperature: ROLE_PLANNER.temperature,
      signal: this.signal,
      skipTools: true,
      ...(modelOverride ? { model: modelOverride } : {}),
    };
    const response = await retryChat(ai, chatParams, this.signal);

    type ParsedStep = {
      id?: string;
      role?: string;
      task?: string;
      description?: string;
      dependencies?: string[];
      depends_on?: string[];
      inputMapping?: Record<string, string>;
      outputKey?: string;
      output_key?: string;
      reviewAfter?: boolean;
      maxReviewRetries?: number;
      critical?: boolean;
    };

    type ParsedPlan = {
      mode?: string;
      steps?: ParsedStep[];
      tasks?: ParsedStep[];
      plan?: { steps?: ParsedStep[] } | ParsedStep[];
    };

    let {
      value: parsed,
      json: planJson,
      error: parseError,
    } = parseFirstValidJsonObject<ParsedPlan>(response.content);

    if (!parsed) {
      this.emitProgress("plan_retry", {
        reason: "planner_invalid_json_first_pass",
        error: parseError,
        raw: response.content.slice(0, 300),
      });

      const errorDetail = parseError ? `\n解析错误: ${parseError}` : "";
      const retryResponse = await retryChat(
        ai,
        {
          ...chatParams,
          messages: [
            ...chatParams.messages,
            { role: "assistant" as const, content: response.content.slice(0, 500) },
            {
              role: "user" as const,
              content: `你上一轮输出不是有效 JSON。${errorDetail}\n请重新输出一个合法 JSON 对象，不要代码块，不要解释文字。仅包含 mode 和 steps 字段，steps 不超过 6。`,
            },
          ],
        },
        this.signal,
        1,
      );

      ({
        value: parsed,
        json: planJson,
        error: parseError,
      } = parseFirstValidJsonObject<ParsedPlan>(retryResponse.content));
    }

    if (!parsed) {
      this.emitProgress("plan_retry", {
        reason: "planner_invalid_json_fallback_single_step",
        error: parseError,
        raw: response.content.slice(0, 300),
      });
      const fallbackMode: ClusterMode = forceMode ?? "parallel_split";
      const fallbackSteps: ClusterStep[] = [{
        id: "step_1",
        role: "researcher",
        task: query,
        dependencies: [],
        outputKey: "step_1_result",
      }];
      const fallbackPlan = createClusterPlan(fallbackMode, fallbackSteps);
      this.messageBus.setContext("_query", query);
      this.messageBus.setContext("_plan", fallbackPlan);
      return fallbackPlan;
    }

    const rawSteps: ParsedStep[] =
      parsed.steps
      ?? parsed.tasks
      ?? (Array.isArray(parsed.plan) ? parsed.plan : parsed.plan?.steps)
      ?? [];

    const planMode: ClusterMode =
      forceMode ??
      (parsed.mode === "multi_role" ? "multi_role" : "parallel_split");

    const stepIdToOutputKey = new Map<string, string>();
    for (let i = 0; i < rawSteps.length; i++) {
      const s = rawSteps[i];
      const id = s.id || `step_${i + 1}`;
      stepIdToOutputKey.set(id, s.outputKey || s.output_key || `${id}_result`);
    }

    const steps: ClusterStep[] = rawSteps.map((s, i) => {
      const deps = s.dependencies ?? s.depends_on ?? [];
      const outputKey = s.outputKey || s.output_key || `step_${i + 1}_result`;
      let inputMapping = s.inputMapping;
      if (!inputMapping && deps.length > 0) {
        inputMapping = {};
        for (const dep of deps) {
          const depOutputKey = stepIdToOutputKey.get(dep) ?? `${dep}_result`;
          inputMapping[depOutputKey] = depOutputKey;
        }
      }
      return {
        id: s.id || `step_${i + 1}`,
        role: s.role || "researcher",
        task: s.task || s.description || "",
        dependencies: deps,
        inputMapping,
        outputKey,
        reviewAfter: s.reviewAfter ?? (autoReview && s.role === "coder"),
        maxReviewRetries: s.maxReviewRetries,
        critical: s.critical,
      };
    });

    if (steps.length === 0) {
      this.emitProgress("plan_retry", { reason: "empty_steps", rawJson: (planJson ?? "").slice(0, 300) });
      const fallbackSteps: ClusterStep[] = [{
        id: "step_1",
        role: "researcher",
        task: query,
        dependencies: [],
        outputKey: "step_1_result",
      }];
      const fallbackPlan = createClusterPlan(planMode, fallbackSteps);
      this.messageBus.setContext("_query", query);
      this.messageBus.setContext("_plan", fallbackPlan);
      return fallbackPlan;
    }

    if (planMode === "parallel_split") {
      for (const s of steps) {
        if (s.dependencies.length > 0) {
          s.dependencies = [];
          s.inputMapping = undefined;
        }
      }
    }

    const plan = createClusterPlan(planMode, steps);
    const errors = validatePlan(plan);
    if (errors.length > 0) {
      throw new Error(`计划验证失败:\n${errors.join("\n")}`);
    }

    this.messageBus.setContext("_query", query);
    this.messageBus.setContext("_plan", plan);

    return plan;
  }

  // ── Approval Phase (Human-in-the-Loop) ──

  private async approvalPhase(plan: ClusterPlan): Promise<PlanApprovalRequest> {
    const request: PlanApprovalRequest = {
      plan,
      status: "pending",
    };

    if (!this.options.onPlanApproval) {
      return { ...request, status: "approved" };
    }

    return this.options.onPlanApproval(request);
  }

  // ── Dispatch Phase ──

  private async dispatchPhase(plan: ClusterPlan): Promise<void> {
    this.setStatus("running");
    const layers = topologicalSort(plan.steps);
    const maxConcurrency = this.options.maxConcurrency ?? 4;
    const failedCriticalSteps = new Set<string>();

    for (const layer of layers) {
      if (this.signal.aborted) throw new Error("已取消");

      const chunks = chunkArray(layer, maxConcurrency);
      for (const chunk of chunks) {
        await Promise.allSettled(
          chunk.map((step) => {
            const isCritical = step.critical !== false;
            const blockedBy = step.dependencies.find(
              (dep) => failedCriticalSteps.has(dep),
            );
            if (blockedBy) {
              this.emitProgress("step_skipped", {
                stepId: step.id,
                reason: `关键依赖 ${blockedBy} 已失败`,
              }, step.id);
              this.messageBus.setContext(
                step.outputKey ?? step.id,
                `[已跳过] 因依赖 ${blockedBy} 失败而跳过`,
              );
              return Promise.resolve();
            }
            return this.executeStepWithReview(step, plan).then(() => {
              const inst = this.getLatestInstanceForStep(step.id, "error");
              if (inst && isCritical) {
                failedCriticalSteps.add(step.id);
              }
            }).catch(() => {
              if (isCritical) failedCriticalSteps.add(step.id);
            });
          }),
        );
      }
    }
  }

  /**
   * 执行一个步骤，若步骤启用了 reviewAfter，则在完成后调用 Reviewer
   * 审查结果。若审查不通过，则带着反馈重新执行（Review-Fix Loop）。
   */
  private async executeStepWithReview(
    step: ClusterStep,
    plan: ClusterPlan,
  ): Promise<void> {
    const maxRetries = step.maxReviewRetries
      ?? this.options.maxReviewRetries
      ?? 2;

    let retries = 0;
    let lastFeedback: ReviewFeedback | null = null;

    while (true) {
      await this.executeStep(step, plan, lastFeedback);

      if (!step.reviewAfter || retries >= maxRetries) break;

      const outputKey = step.outputKey ?? step.id;
      const stepResult = this.messageBus.getContext(outputKey);

      if (typeof stepResult !== "string" || !stepResult) break;

      const instanceForStep = this.getLatestInstanceForStep(step.id, "done");
      if (!instanceForStep) break;

      this.emitProgress("step_review", { stepId: step.id, retries }, step.id, instanceForStep.id);
      this.updateInstance(instanceForStep.id, { status: "reviewing" });

      const feedback = await this.reviewStep(step, stepResult);

      this.messageBus.publish({
        from: "reviewer",
        to: instanceForStep.id,
        type: "review",
        payload: feedback,
      });

      if (feedback.passed) break;

      retries++;
      lastFeedback = feedback;
      this.updateInstance(instanceForStep.id, {
        reviewCount: retries,
        status: "error",
      });
      this.emitProgress("step_retry", { stepId: step.id, retries, feedback }, step.id);
    }
  }

  private throttledInstanceUpdate(instanceId: string): void {
    if (this.stepUpdateTimers.has(instanceId)) return;
    this.stepUpdateTimers.set(instanceId, setTimeout(() => {
      this.stepUpdateTimers.delete(instanceId);
      const current = this.instances.get(instanceId);
      if (current) {
        this.options.onInstanceUpdate?.({ ...current, steps: [...current.steps] });
      }
    }, 500));
  }

  private flushStepUpdates(): void {
    for (const [id, timer] of this.stepUpdateTimers) {
      clearTimeout(timer);
      this.stepUpdateTimers.delete(id);
      const current = this.instances.get(id);
      if (current) {
        this.options.onInstanceUpdate?.({ ...current, steps: [...current.steps] });
      }
    }
  }

  /** Find the most recently created instance for a given step & status. */
  private getLatestInstanceForStep(
    stepId: string,
    status: AgentInstance["status"],
  ): AgentInstance | undefined {
    let best: AgentInstance | undefined;
    for (const inst of this.instances.values()) {
      if (inst.stepId === stepId && inst.status === status) {
        if (!best || (inst.startedAt ?? 0) > (best.startedAt ?? 0)) {
          best = inst;
        }
      }
    }
    return best;
  }

  private async executeStep(
    step: ClusterStep,
    plan: ClusterPlan,
    reviewFeedback?: ReviewFeedback | null,
  ): Promise<void> {
    const role = getPresetRole(step.role) ?? (await getAsyncRole(step.role));
    if (!role) {
      this.messageBus.setContext(step.outputKey ?? step.id, {
        error: `未知角色: ${step.role}`,
      });
      return;
    }

    const instanceId = `agent-${step.id}-${Date.now().toString(36)}`;
    const instance: AgentInstance = {
      id: instanceId,
      role,
      status: "running",
      stepId: step.id,
      steps: [],
      startedAt: Date.now(),
    };
    this.instances.set(instanceId, instance);
    this.options.onInstanceUpdate?.(instance);
    this.emitProgress("step_started", { role: role.id, task: step.task }, step.id, instanceId);

    this.messageBus.publish({
      from: "orchestrator",
      to: instanceId,
      type: "request",
      payload: { step },
    });

    let inputContext: Record<string, unknown> = {};
    const failedDeps: string[] = [];

    if (step.inputMapping) {
      inputContext = this.messageBus.resolveInputMapping(step.inputMapping);
      for (const [key, val] of Object.entries(inputContext)) {
        if (isErrorResult(val)) failedDeps.push(key);
      }
    } else if (step.dependencies.length > 0) {
      for (const dep of step.dependencies) {
        const depStep = plan.steps.find((s) => s.id === dep);
        const depKey = depStep?.outputKey ?? `${dep}_result`;
        const val = this.messageBus.getContext(depKey);
        if (val !== undefined) {
          if (isErrorResult(val)) {
            failedDeps.push(dep);
            inputContext[depKey] = `[前置步骤 ${dep} 执行失败: ${(val as { error: string }).error}]`;
          } else {
            inputContext[depKey] = val;
          }
        }
      }
    }

    if (failedDeps.length > 0 && failedDeps.length === step.dependencies.length) {
      const errMsg = `所有前置依赖均失败 (${failedDeps.join(", ")})，跳过执行`;
      this.updateInstance(instanceId, { status: "error", error: errMsg, finishedAt: Date.now() });
      this.messageBus.setContext(step.outputKey ?? step.id, { error: errMsg });
      this.emitProgress("step_completed", { error: errMsg }, step.id, instanceId);
      return;
    }

    const allContext: Record<string, unknown> = { ...plan.sharedContext, ...inputContext };

    if (this.runImages?.length) {
      allContext._images = this.runImages;
    }
    if (this.options.workspaceRoot) {
      allContext._workspaceRoot = this.options.workspaceRoot;
    }
    if (reviewFeedback) {
      allContext._review_feedback = {
        issues: reviewFeedback.issues,
        summary: reviewFeedback.summary,
      };
    }

    const remoteBridge = this.remoteBridges.get(step.role);
    const bridge = remoteBridge ?? new LocalAgentBridge(instanceId, this.options.confirmDangerousAction, this.options.askUser);
    this.bridges.set(instanceId, bridge);

    const modelOverride = this.resolveModel(step.role);

    try {
      let task = step.task;

      if (failedDeps.length > 0) {
        task += `\n\n⚠️ 注意：部分前置步骤失败 (${failedDeps.join(", ")})，请基于可用的上下文信息尽力完成任务。`;
      }

      const hasAskUser = !!this.options.askUser;
      const autonomyHint = hasAskUser
        ? `[集群模式] 自主执行子任务，缺少关键信息时可用 ask_user 工具提问（禁止在文本中提问）。`
        : `[集群自主模式] 自主执行子任务，无法与用户交互。信息不足时做合理假设并说明。`;
      const codingHint = getClusterStepCodingHint(role.id, {
        codingMode: this.options.codingMode,
        largeProjectMode: this.options.largeProjectMode,
        openClawMode: this.options.openClawMode,
      });
      const projectBlock = this.projectContext ? `\n\n${this.projectContext}` : "";
      const prefix = [autonomyHint, codingHint].filter(Boolean).join("\n");
      task = `${prefix}${projectBlock}\n\n## 任务\n${task}`;

      if (this.runImages?.length) {
        task += this.supportsImageInput(modelOverride)
          ? `\n\n## 用户附带的图片\n用户已附带 ${this.runImages.length} 张图片，这些图片已自动包含在本次对话中，你可以直接看到并分析它们。请勿使用截图工具或其他方式重新获取图片，也不要对图片路径调用 read_file / read_file_range；直接基于已有图片进行分析即可。`
          : `\n\n## 用户附带的图片\n用户附带了 ${this.runImages.length} 张图片，但你当前使用的模型不支持直接识别图片内容。不要假装自己看到了图片，也不要把图片路径当作文本文件去读取。若任务依赖图片细节，请明确说明需要切换到支持视觉输入的模型，或先提供 OCR / 文字描述。`;
      }

      if (reviewFeedback) {
        const issueList = reviewFeedback.issues
          .map((i) => `- [${i.severity}] ${i.description}${i.fix ? ` (建议: ${i.fix})` : ""}`)
          .join("\n");
        task += `\n\n## 上一轮 Review 反馈\n审查未通过，请修复以下问题：\n${issueList}\n\n总结: ${reviewFeedback.summary}`;
      }

      const stepAbort = new AbortController();
      const stepTimeoutMs = this.options.openClawMode
        ? STEP_EXECUTION_TIMEOUT_OPENCLAW_MS
        : STEP_EXECUTION_TIMEOUT_MS;
      const stepTimer = setTimeout(() => stepAbort.abort("单步执行超时"), stepTimeoutMs);
      const onGlobalAbort = () => stepAbort.abort(this.signal.reason);
      this.signal.addEventListener("abort", onGlobalAbort, { once: true });

      let result: Awaited<ReturnType<typeof bridge.run>>;
      try {
        result = await bridge.run(task, allContext, {
          role: modelOverride ? { ...role, modelOverride } : role,
          signal: stepAbort.signal,
          workspaceRoot: this.options.workspaceRoot,
          maxIterations: getEnhancedClusterRoleIterations(
            role.maxIterations,
            role.id,
            {
              codingMode: this.options.codingMode,
              largeProjectMode: this.options.largeProjectMode,
              openClawMode: this.options.openClawMode,
            },
          ),
          onStep: (s) => {
            const current = this.instances.get(instanceId);
            if (current) {
              current.steps.push(s);
              this.options.onStep?.(instanceId, s);
              this.throttledInstanceUpdate(instanceId);
              this.emitProgress("step_progress", { step: s }, step.id, instanceId);
            }
          },
        });
      } finally {
        clearTimeout(stepTimer);
        this.signal.removeEventListener("abort", onGlobalAbort);
      }

      const pendingTimer = this.stepUpdateTimers.get(instanceId);
      if (pendingTimer) {
        clearTimeout(pendingTimer);
        this.stepUpdateTimers.delete(instanceId);
      }

      if (result.error) {
        this.updateInstance(instanceId, {
          status: "error",
          error: result.error,
          finishedAt: Date.now(),
          memoryRecallAttempted: result.memoryRecallAttempted,
          appliedMemoryPreview: result.appliedMemoryPreview,
          transcriptRecallAttempted: result.transcriptRecallAttempted,
          transcriptRecallHitCount: result.transcriptRecallHitCount,
          appliedTranscriptPreview: result.appliedTranscriptPreview,
        });
        this.messageBus.setContext(step.outputKey ?? step.id, {
          error: result.error,
        });
      } else {
        this.updateInstance(instanceId, {
          status: "done",
          result: result.answer,
          finishedAt: Date.now(),
          memoryRecallAttempted: result.memoryRecallAttempted,
          appliedMemoryPreview: result.appliedMemoryPreview,
          transcriptRecallAttempted: result.transcriptRecallAttempted,
          transcriptRecallHitCount: result.transcriptRecallHitCount,
          appliedTranscriptPreview: result.appliedTranscriptPreview,
        });
        this.messageBus.setContext(step.outputKey ?? step.id, result.answer);
      }

      this.emitProgress("step_completed", {
        answer: result.answer?.slice(0, 200),
        error: result.error,
      }, step.id, instanceId);

      this.messageBus.publish({
        from: instanceId,
        type: "result",
        payload: {
          stepId: step.id,
          answer: result.answer,
          error: result.error,
        },
      });
    } catch (e) {
      const pendingTimer = this.stepUpdateTimers.get(instanceId);
      if (pendingTimer) {
        clearTimeout(pendingTimer);
        this.stepUpdateTimers.delete(instanceId);
      }
      const error = e instanceof Error ? e.message : String(e);
      this.updateInstance(instanceId, {
        status: "error",
        error,
        finishedAt: Date.now(),
      });
      this.messageBus.setContext(step.outputKey ?? step.id, { error });
    }
  }

  // ── Review Phase ──

  private async reviewStep(
    step: ClusterStep,
    stepResult: string,
  ): Promise<ReviewFeedback> {
    // 对 coder 步骤使用带工具的 Agent 审查（可读文件验证实际代码）
    if (step.role === "coder") {
      return this.reviewStepWithTools(step, stepResult);
    }
    // 非 coding 步骤保持轻量纯 LLM 审查
    return this.reviewStepLightweight(step, stepResult);
  }

  /** 带工具的 Agent 审查（仅用于 coder 步骤） */
  private async reviewStepWithTools(
    step: ClusterStep,
    stepResult: string,
  ): Promise<ReviewFeedback> {
    const instanceId = `reviewer-${step.id}-${Date.now().toString(36)}`;
    const role = ROLE_REVIEWER;
    const modelOverride = this.resolveModel("reviewer");

    const bridge = new LocalAgentBridge(instanceId, this.options.confirmDangerousAction);
    this.bridges.set(instanceId, bridge);

    const reviewTask = `${ROLE_REVIEWER.systemPrompt}

[集群自主模式] 无法与用户交互，直接给出审查结论。

## 审查任务
请审查以下编码步骤的执行结果。你必须使用 read_file_range 和 search_in_files 工具验证实际文件内容，不要仅凭执行结果文本判断。

### 步骤信息
- 步骤 ID: ${step.id}
- 任务: ${step.task}

### 执行结果
${stepResult}

## 输出要求
审查完成后，你的最终回答必须是且仅是一个 JSON 对象：
{
  "passed": true/false,
  "issues": [
    { "severity": "critical|warning|suggestion", "description": "...", "fix": "..." }
  ],
  "summary": "审查总结"
}`;

    try {
      const result = await bridge.run(reviewTask, {}, {
        role: modelOverride ? { ...role, modelOverride } : role,
        signal: this.signal,
        maxIterations: getEnhancedClusterRoleIterations(
          role.maxIterations,
          role.id,
          {
            codingMode: this.options.codingMode,
            largeProjectMode: this.options.largeProjectMode,
            openClawMode: this.options.openClawMode,
          },
        ),
        onStep: (s) => {
          this.emitProgress("step_progress", { step: s, reviewer: true }, step.id, instanceId);
        },
      });

      return this.parseReviewResult(result.answer);
    } catch (err) {
      return { passed: false, issues: [{ severity: "warning", description: `审查 Agent 执行失败: ${err}`, fix: "请重新审查" }], summary: "审查执行异常，默认不通过" };
    } finally {
      this.bridges.delete(instanceId);
    }
  }

  /** 纯 LLM 轻量审查（用于非 coder 步骤） */
  private async reviewStepLightweight(
    step: ClusterStep,
    stepResult: string,
  ): Promise<ReviewFeedback> {
    const ai = getMToolsAI("cluster");
    const modelOverride = this.resolveModel("reviewer");
    const chatRuntimeContext = await this.buildChatRuntimeContext(step.task);

    const reviewPrompt = `## 审查目标
步骤 ID: ${step.id}
角色: ${step.role}
任务: ${step.task}

## 执行结果
${stepResult}

## 输出要求
请以 JSON 格式返回审查结果：
{
  "passed": true/false,
  "issues": [
    { "severity": "critical|warning|suggestion", "description": "...", "fix": "..." }
  ],
  "summary": "审查总结"
}
只返回 JSON，不要附加其他内容。`;

    const response = await retryChat(ai, {
      messages: [
        {
          role: "system",
          content: [
            ROLE_REVIEWER.systemPrompt,
            chatRuntimeContext.systemPromptBlock || "",
          ]
            .filter((block): block is string => typeof block === "string" && block.trim().length > 0)
            .join("\n\n"),
        },
        ...chatRuntimeContext.contextMessages,
        { role: "user", content: reviewPrompt },
      ],
      temperature: ROLE_REVIEWER.temperature,
      signal: this.signal,
      skipTools: true,
      ...(modelOverride ? { model: modelOverride } : {}),
    }, this.signal);

    return this.parseReviewResult(response.content);
  }

  /** 统一解析审查结果 */
  private parseReviewResult(text: string): ReviewFeedback {
    const json = extractJson(text);
    if (!json) {
      return { passed: false, issues: [{ severity: "warning", description: "审查结果解析失败，无法确认质量", fix: "请重新审查" }], summary: "审查结果解析失败，默认不通过" };
    }
    try {
      const parsed = JSON.parse(json) as ReviewFeedback;
      return {
        passed: !!parsed.passed,
        issues: Array.isArray(parsed.issues) ? parsed.issues : [],
        summary: parsed.summary || "无总结",
      };
    } catch {
      return { passed: false, issues: [{ severity: "warning", description: "审查 JSON 解析失败", fix: "请重新审查" }], summary: "审查结果 JSON 解析失败，默认不通过" };
    }
  }

  // ── Aggregate Phase ──

  private async aggregatePhase(
    originalQuery: string,
    plan: ClusterPlan,
  ): Promise<string> {
    const results: Record<string, unknown> = {};
    for (const step of plan.steps) {
      const key = step.outputKey ?? step.id;
      results[key] = this.messageBus.getContext(key);
    }

    const allSuccessful = [...this.instances.values()].every(
      (inst) => inst.status === "done",
    );

    if (plan.steps.length === 1 && allSuccessful) {
      const singleResult = results[plan.steps[0].outputKey ?? plan.steps[0].id];
      if (typeof singleResult === "string") return singleResult;
    }

    const ai = getMToolsAI("cluster");
    const { totalBudget: TOTAL_BUDGET, coderBudget: CODER_BUDGET } =
      getClusterAggregateBudgets({
        codingMode: this.options.codingMode,
        largeProjectMode: this.options.largeProjectMode,
        openClawMode: this.options.openClawMode,
      });
    const coderStepCount = plan.steps.filter((s) => s.role === "coder").length;
    const otherStepCount = plan.steps.length - coderStepCount;
    // coder 步骤分配更多预算，非 coder 步骤用原始预算
    const maxPerCoderStep = coderStepCount > 0
      ? Math.max(1500, Math.floor(CODER_BUDGET / coderStepCount))
      : 0;
    const maxPerOtherStep = otherStepCount > 0
      ? Math.max(800, Math.floor(TOTAL_BUDGET / Math.max(otherStepCount, 1)))
      : 0;

    const stepSummaries = plan.steps.map((step) => {
      const key = step.outputKey ?? step.id;
      const result = results[key];
      let resultStr = typeof result === "string"
        ? result
        : JSON.stringify(result, null, 2);
      const limit = step.role === "coder" ? maxPerCoderStep : maxPerOtherStep;
      if (resultStr.length > limit) {
        resultStr = resultStr.slice(0, limit) + "\n...(结果已截断)";
      }
      return `### ${step.id} (角色: ${step.role})\n任务: ${step.task}\n结果:\n${resultStr}`;
    }).join("\n\n---\n\n");

    const codingAggregateHint = this.options.codingMode
      ? `
5. 如果涉及代码改动，必须清晰列出：修改文件路径、关键变更点、验证命令与结果、剩余风险`
      : "";
    const chatRuntimeContext = await this.buildChatRuntimeContext(originalQuery);

    const aggregatePrompt = `你是一个结果汇总专家。多个 Agent 已经协作完成了用户的任务，请汇总所有结果，给出最终的、完整的答案。

## 原始任务
${originalQuery}

## 执行计划
模式: ${plan.mode}
步骤数: ${plan.steps.length}

## 各 Agent 执行结果

${stepSummaries}

## 要求
1. 综合所有 Agent 的结果，给出完整、连贯的最终答案
2. 如果某个步骤失败了，说明原因并给出已完成部分的总结
3. 不要重复各步骤的原始输出，而是提炼关键信息
4. 用中文回答${codingAggregateHint}`;

    const aggregateSystemPrompt = `你是 51ToolBox 智能助手集群的结果汇总 Agent。

## 职责
综合多个子 Agent 的执行结果，为用户提供完整、连贯、高质量的最终答案。

## 汇总原则
1. **提炼关键信息**：不要简单拼接各步骤的原始输出，提炼要点并组织成逻辑清晰的答案
2. **保持一致性**：消除各步骤之间的矛盾或重复内容
3. **标注来源**：重要结论注明来自哪个步骤（如需要）
4. **处理失败**：如果某步骤失败，说明原因并基于成功步骤给出最佳答案
5. **代码变更保留细节**：如果涉及代码修改，保留具体的文件路径、修改内容等关键细节
6. **用中文回答**`;

    const response = await retryChat(ai, {
      messages: [
        {
          role: "system",
          content: [
            aggregateSystemPrompt,
            chatRuntimeContext.systemPromptBlock || "",
          ]
            .filter((block): block is string => typeof block === "string" && block.trim().length > 0)
            .join("\n\n"),
        },
        ...chatRuntimeContext.contextMessages,
        { role: "user", content: aggregatePrompt },
      ],
      temperature: 0.5,
      signal: this.signal,
      skipTools: true,
    }, this.signal);

    return response.content;
  }

  // ── Model Routing ──

  private resolveModel(roleId: string): string | undefined {
    const config = this.options.modelRouting;
    if (!config) return undefined;
    const rule = config.rules.find((r) => r.roleId === roleId);
    return rule?.modelId ?? config.defaultModel;
  }

  private supportsImageInput(modelOverride?: string): boolean {
    const config = useAIStore.getState().config;
    return modelSupportsImageInput(modelOverride || config.model || "", config.protocol);
  }

  // ── Abort ──

  private async abortBridges(): Promise<void> {
    for (const bridge of this.bridges.values()) {
      await bridge.abort();
    }
  }

  async abort(): Promise<void> {
    this.internalAbort.abort("已取消");
    await this.abortBridges();
  }
}

function repairJsonString(text: string): string | null {
  let s = text.trim();
  // Strip markdown fences
  s = s.replace(/^```(?:json)?\s*\n?/i, "").replace(/\n?```\s*$/i, "");
  // Find outermost braces
  const start = s.indexOf("{");
  const end = s.lastIndexOf("}");
  if (start < 0) return null;
  if (end <= start) {
    s = s.slice(start) + "}";
  } else {
    s = s.slice(start, end + 1);
  }
  // Remove trailing commas before } or ]
  s = s.replace(/,\s*([}\]])/g, "$1");
  // Try parsing
  try { JSON.parse(s); return s; } catch { return null; }
}

function extractJson(text: string): string | null {
  return parseFirstValidJsonObject<Record<string, unknown>>(text).json;
}

function parseFirstValidJsonObject<T = Record<string, unknown>>(text: string): {
  value: T | null;
  json: string | null;
  error?: string;
} {
  let lastError: string | undefined;
  for (const candidate of collectJsonCandidates(text)) {
    try {
      const parsed = JSON.parse(candidate);
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
        lastError = "JSON 不是对象";
        continue;
      }
      return {
        value: parsed as T,
        json: candidate,
      };
    } catch (err) {
      lastError = err instanceof Error ? err.message : String(err);
    }
  }
  return {
    value: null,
    json: null,
    ...(lastError ? { error: lastError } : {}),
  };
}

function collectJsonCandidates(text: string): string[] {
  const candidates: string[] = [];
  const seen = new Set<string>();
  const push = (value?: string | null) => {
    if (!value) return;
    const trimmed = value.trim();
    if (!trimmed || seen.has(trimmed)) return;
    seen.add(trimmed);
    candidates.push(trimmed);
  };

  const fenceRegex = /```(?:json)?\s*\n?([\s\S]*?)\n?```/gi;
  for (const match of text.matchAll(fenceRegex)) {
    push(match[1]);
  }

  for (const balanced of extractBalancedJsonObjects(text)) {
    push(balanced);
    push(repairJsonString(balanced));
  }

  push(repairJsonString(text));
  return candidates;
}

function extractBalancedJsonObjects(text: string, maxCandidates = 12): string[] {
  const results: string[] = [];
  let depth = 0;
  let start = -1;
  let inString = false;
  let escaped = false;

  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (inString) {
      if (escaped) {
        escaped = false;
        continue;
      }
      if (ch === "\\") {
        escaped = true;
        continue;
      }
      if (ch === "\"") {
        inString = false;
      }
      continue;
    }

    if (ch === "\"") {
      inString = true;
      continue;
    }

    if (ch === "{") {
      if (depth === 0) start = i;
      depth += 1;
      continue;
    }

    if (ch === "}" && depth > 0) {
      depth -= 1;
      if (depth === 0 && start >= 0) {
        results.push(text.slice(start, i + 1));
        start = -1;
        if (results.length >= maxCandidates) break;
      }
    }
  }

  return results;
}

function isErrorResult(val: unknown): val is { error: string } {
  return (
    typeof val === "object" &&
    val !== null &&
    "error" in val &&
    typeof (val as Record<string, unknown>).error === "string"
  );
}

function chunkArray<T>(arr: T[], size: number): T[][] {
  const chunks: T[][] = [];
  for (let i = 0; i < arr.length; i += size) {
    chunks.push(arr.slice(i, i + size));
  }
  return chunks;
}
