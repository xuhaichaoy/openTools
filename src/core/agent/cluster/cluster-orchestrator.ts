import { getMToolsAI } from "@/core/ai/mtools-ai";
import type { AgentStep } from "@/plugins/builtin/SmartAgent/core/react-agent";
import { ROLE_PLANNER, ROLE_REVIEWER, getRoleById as getPresetRole } from "./preset-roles";
import { getRoleById as getAsyncRole } from "./agent-role";
import { LocalAgentBridge, type ConfirmDangerousAction, type AskUserCallback } from "./local-agent-bridge";
import { ClusterMessageBus } from "./message-bus";
import { createClusterPlan, topologicalSort, validatePlan } from "./cluster-plan";
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

const CLUSTER_EXECUTION_TIMEOUT_MS = 600_000; // 10 minutes

/**
 * Retry wrapper for ai.chat calls — handles transient network / decoding errors.
 */
async function retryChat(
  ai: ReturnType<typeof getMToolsAI>,
  params: Parameters<ReturnType<typeof getMToolsAI>["chat"]>[0],
  signal?: AbortSignal,
  maxRetries = 2,
): Promise<{ content: string }> {
  const TRANSIENT_RE = /decoding|network|econnreset|timeout|stream|fetch/i;
  let lastError: unknown;
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    if (signal?.aborted) throw new Error("Aborted");
    try {
      return await ai.chat(params);
    } catch (err: unknown) {
      lastError = err;
      if (signal?.aborted) throw err;
      const msg = err instanceof Error ? err.message : String(err);
      if (!TRANSIENT_RE.test(msg) || attempt === maxRetries) throw err;
      const delay = 1000 * 2 ** attempt;
      await new Promise((r) => setTimeout(r, delay));
    }
  }
  throw lastError;
}

export interface ClusterOrchestratorOptions {
  maxConcurrency?: number;
  signal?: AbortSignal;
  /** 全局执行超时（ms），默认 600s */
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
          return {
            planId: plan.id,
            mode: plan.mode,
            finalAnswer: "用户取消了执行计划。",
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
    const ai = getMToolsAI();

    const autoReview = this.options.autoReviewCodeSteps ?? false;
    const reviewHint = autoReview
      ? "\n- 对于 coder 角色的步骤，设置 reviewAfter: true 以启用自动代码审查"
      : "";

    const imageHint = this.runImages?.length
      ? `\n\n注意：用户已附带 ${this.runImages.length} 张图片，这些图片会自动传递给每个执行步骤的 Agent，无需再通过工具去寻找或获取图片。请在规划时考虑这些已有图片。`
      : "";

    const plannerPrompt = `${ROLE_PLANNER.systemPrompt}
${reviewHint}

${forceMode ? `强制使用模式: ${forceMode}` : "根据任务复杂度自动选择 multi_role 或 parallel_split 模式。"}

用户任务: ${query}${imageHint}

请分析任务并返回 JSON 执行计划。只返回 JSON，不要附加其他内容。`;

    const modelOverride = this.resolveModel("planner");
    const chatParams = {
      messages: [
        { role: "system" as const, content: "你是任务规划 Agent，只输出 JSON 格式的执行计划。" },
        { role: "user" as const, content: plannerPrompt, ...(this.runImages?.length ? { images: this.runImages } : {}) },
      ],
      temperature: ROLE_PLANNER.temperature,
      signal: this.signal,
      ...(modelOverride ? { model: modelOverride } : {}),
    };
    const response = await retryChat(ai, chatParams, this.signal);

    let planJson = extractJson(response.content);

    if (!planJson) {
      const repaired = repairJsonString(response.content);
      planJson = repaired ? extractJson(repaired) : null;
    }

    if (!planJson) {
      throw new Error(`Planner 未返回有效的 JSON 计划: ${response.content.slice(0, 200)}`);
    }

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
    };

    type ParsedPlan = {
      mode?: string;
      steps?: ParsedStep[];
      tasks?: ParsedStep[];
      plan?: { steps?: ParsedStep[] } | ParsedStep[];
    };

    let parsed: ParsedPlan;
    try {
      parsed = JSON.parse(planJson) as ParsedPlan;
    } catch {
      throw new Error(`Planner 返回的 JSON 解析失败: ${planJson.slice(0, 200)}`);
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
      };
    });

    if (steps.length === 0) {
      this.emitProgress("plan_retry", { reason: "empty_steps", rawJson: planJson.slice(0, 300) });
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

    for (const layer of layers) {
      if (this.signal.aborted) throw new Error("已取消");

      const chunks = chunkArray(layer, maxConcurrency);
      for (const chunk of chunks) {
        await Promise.allSettled(
          chunk.map((step) => this.executeStepWithReview(step, plan)),
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
        ? `[集群模式] 你正在 Agent 集群中作为独立子任务执行。\n规则：\n- 优先自主执行，根据现有信息做合理判断\n- 如果确实缺少关键信息无法继续，可以使用 ask_user 工具向用户提问\n- 不要在回复文本中直接提问，必须通过 ask_user 工具\n- 直接给出结果，不要列出选项让用户选择`
        : `[集群自主模式] 你正在 Agent 集群中作为独立子任务执行，无法与用户交互。\n重要规则：\n- 不要向用户提问或要求确认，直接根据现有信息做出合理判断并执行\n- 如果任务描述不够详细，做合理假设并说明假设内容\n- 直接给出结果，不要列出选项让用户选择`;
      task = `${autonomyHint}\n\n## 任务\n${task}`;

      if (this.runImages?.length) {
        task += `\n\n## 用户附带的图片\n用户已附带 ${this.runImages.length} 张图片，这些图片已自动包含在本次对话中，你可以直接看到并分析它们。请勿使用截图工具或其他方式重新获取图片，直接基于已有图片进行分析即可。`;
      }

      if (reviewFeedback) {
        const issueList = reviewFeedback.issues
          .map((i) => `- [${i.severity}] ${i.description}${i.fix ? ` (建议: ${i.fix})` : ""}`)
          .join("\n");
        task += `\n\n## 上一轮 Review 反馈\n审查未通过，请修复以下问题：\n${issueList}\n\n总结: ${reviewFeedback.summary}`;
      }

      const result = await bridge.run(task, allContext, {
        role: modelOverride ? { ...role, modelOverride } : role,
        signal: this.signal,
        maxIterations: role.maxIterations,
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
        });
        this.messageBus.setContext(step.outputKey ?? step.id, {
          error: result.error,
        });
      } else {
        this.updateInstance(instanceId, {
          status: "done",
          result: result.answer,
          finishedAt: Date.now(),
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
    const ai = getMToolsAI();
    const modelOverride = this.resolveModel("reviewer");

    const reviewPrompt = `${ROLE_REVIEWER.systemPrompt}

## 审查目标
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
        { role: "system", content: "你是代码/结果审查 Agent，以 JSON 格式输出审查结果。" },
        { role: "user", content: reviewPrompt },
      ],
      temperature: ROLE_REVIEWER.temperature,
      signal: this.signal,
      ...(modelOverride ? { model: modelOverride } : {}),
    }, this.signal);

    const json = extractJson(response.content);
    if (!json) {
      return { passed: true, issues: [], summary: "审查结果解析失败，默认通过" };
    }

    try {
      const parsed = JSON.parse(json) as ReviewFeedback;
      return {
        passed: !!parsed.passed,
        issues: Array.isArray(parsed.issues) ? parsed.issues : [],
        summary: parsed.summary || "无总结",
      };
    } catch {
      return { passed: true, issues: [], summary: "审查结果 JSON 解析失败，默认通过" };
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

    const ai = getMToolsAI();
    const maxPerStep = Math.max(800, Math.floor(12000 / Math.max(plan.steps.length, 1)));
    const stepSummaries = plan.steps.map((step) => {
      const key = step.outputKey ?? step.id;
      const result = results[key];
      let resultStr = typeof result === "string"
        ? result
        : JSON.stringify(result, null, 2);
      if (resultStr.length > maxPerStep) {
        resultStr = resultStr.slice(0, maxPerStep) + "\n...(结果已截断)";
      }
      return `### ${step.id} (角色: ${step.role})\n任务: ${step.task}\n结果:\n${resultStr}`;
    }).join("\n\n---\n\n");

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
4. 用中文回答`;

    const response = await retryChat(ai, {
      messages: [
        { role: "system", content: "你是结果汇总 Agent，负责综合多个子任务的执行结果。" },
        { role: "user", content: aggregatePrompt },
      ],
      temperature: 0.5,
      signal: this.signal,
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
  const jsonBlockMatch = text.match(/```(?:json)?\s*\n?([\s\S]*?)\n?```/);
  if (jsonBlockMatch) return jsonBlockMatch[1].trim();

  const braceMatch = text.match(/\{[\s\S]*\}/);
  if (braceMatch) {
    try {
      JSON.parse(braceMatch[0]);
      return braceMatch[0];
    } catch {
      // not valid JSON
    }
  }
  return null;
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
