import type { ToolDefinition } from "../actor/types";
import type { ActorSystem } from "../actor/actor-system";
import type { AgentActor } from "../actor/agent-actor";
import { getAgentTaskManager } from "@/core/task-center";
import type { AgentTask } from "@/core/task-center/agent-task-types";
import {
  appendAgentTaskOutputFile,
  ensureAgentTaskOutputFile,
} from "@/core/task-center/agent-task-output-file";
import { getBackgroundAgentRegistry } from "../actor/background-agent-registry";
import { persistTranscriptActorResumeMetadata } from "../actor/actor-transcript";
import {
  buildResumeMetadata,
  enrichContextWithActorSnapshot,
  getAgentResumeService,
  type ResumeContext,
} from "../actor/agent-resume-service";

export const AGENT_TOOL_NAME = "agent";

export interface AgentToolInput {
  description: string;
  prompt: string;
  subagent_type?: string;
  run_in_background?: boolean;
  model?: string;
}

export interface AgentToolOutput {
  success: boolean;
  agent_id: string;
  task_id: string;
  message: string;
  output_file?: string;
  resumable?: boolean;
}

function buildAgentTask(params: {
  taskId: string;
  sessionId: string;
  agentId: string;
  agentName: string;
  description: string;
  prompt: string;
  parentActorId?: string;
  status: AgentTask["status"];
  outputFile?: string;
  subagentType?: string;
  model?: string;
}): AgentTask {
  const now = Date.now();
  return {
    taskId: params.taskId,
    sessionId: params.sessionId,
    source: "background",
    backend: "in_process",
    status: params.status,
    title: params.description,
    description: params.prompt,
    createdAt: now,
    startedAt: params.status === "queued" ? undefined : now,
    lastActiveAt: now,
    spawnerActorId: params.parentActorId,
    targetActorId: params.agentId,
    targetName: params.agentName,
    recentActivity: [],
    recentActivitySummary: params.status === "queued"
      ? `Agent ${params.description} 等待启动`
      : `Agent ${params.description} 运行中`,
    pendingMessageCount: 0,
    resumable: true,
    outputFile: params.outputFile,
    metadata: {
      agentId: params.agentId,
      subagentType: params.subagentType,
      description: params.description,
      prompt: params.prompt,
      model: params.model,
      tool: AGENT_TOOL_NAME,
    },
  };
}

async function executeAgent(
  agent: {
    actor?: AgentActor;
    execute(prompt?: string): Promise<string>;
  },
  runtime: {
    taskId: string;
    outputFile: string;
    baseContext: ResumeContext;
    sessionId: string;
    agentId: string;
    taskManager: ReturnType<typeof getAgentTaskManager>;
  },
  prompt: string,
): Promise<string> {
  runtime.taskManager.updateTask(runtime.taskId, {
    status: "running",
    startedAt: Date.now(),
    lastActiveAt: Date.now(),
    recentActivitySummary: "Agent 正在执行",
    outputFile: runtime.outputFile,
  });
  try {
    const result = await agent.execute(prompt);
    const resumeContext = enrichContextWithActorSnapshot(
      {
        ...runtime.baseContext,
        lastMessage: prompt,
        outputFile: runtime.outputFile,
        pendingMessages: [],
      },
      agent.actor,
    );
    getAgentResumeService().saveContext(resumeContext);
    await persistTranscriptActorResumeMetadata(
      runtime.sessionId,
      runtime.agentId,
      buildResumeMetadata(resumeContext),
    ).catch(() => undefined);
    await appendAgentTaskOutputFile({
      outputFile: runtime.outputFile,
      prompt,
      status: "completed",
      result,
      timestamp: Date.now(),
    });
    runtime.taskManager.updateTask(runtime.taskId, {
      status: "completed",
      result,
      completedAt: Date.now(),
      lastActiveAt: Date.now(),
      recentActivitySummary: "Agent 已完成",
      pendingMessageCount: 0,
      outputFile: runtime.outputFile,
    });
    getBackgroundAgentRegistry().complete(runtime.taskId, runtime.outputFile);
    return result;
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    const resumeContext = enrichContextWithActorSnapshot(
      {
        ...runtime.baseContext,
        lastMessage: prompt,
        outputFile: runtime.outputFile,
      },
      agent.actor,
    );
    getAgentResumeService().saveContext(resumeContext);
    await persistTranscriptActorResumeMetadata(
      runtime.sessionId,
      runtime.agentId,
      buildResumeMetadata(resumeContext),
    ).catch(() => undefined);
    await appendAgentTaskOutputFile({
      outputFile: runtime.outputFile,
      prompt,
      status: "failed",
      error: errorMessage,
      timestamp: Date.now(),
    });
    runtime.taskManager.updateTask(runtime.taskId, {
      status: "failed",
      error: errorMessage,
      completedAt: Date.now(),
      lastActiveAt: Date.now(),
      recentActivitySummary: "Agent 执行失败",
      outputFile: runtime.outputFile,
    });
    getBackgroundAgentRegistry().fail(runtime.taskId, errorMessage);
    throw error;
  }
}

function executeAgentAsync(
  agent: {
    actor?: AgentActor;
    execute(prompt?: string): Promise<string>;
  },
  runtime: {
    taskId: string;
    outputFile: string;
    baseContext: ResumeContext;
    sessionId: string;
    agentId: string;
    taskManager: ReturnType<typeof getAgentTaskManager>;
  },
  prompt: string,
): void {
  void executeAgent(agent, runtime, prompt);
}

export function createAgentTool(actorSystem: ActorSystem): ToolDefinition {
  return {
    name: AGENT_TOOL_NAME,
    description: "Launch a specialized agent to handle complex tasks",
    inputSchema: {
      type: "object",
      properties: {
        description: {
          type: "string",
          description: "Short 3-5 word description of what the agent will do",
        },
        prompt: {
          type: "string",
          description: "The task for the agent to perform",
        },
        subagent_type: {
          type: "string",
          description: "Type of specialized agent (explore, plan, general-purpose, etc)",
        },
        run_in_background: {
          type: "boolean",
          description: "Run agent in background",
        },
        model: {
          type: "string",
          description: "Model override",
        },
      },
      required: ["description", "prompt"],
    },
    handler: async (input: AgentToolInput, context): Promise<AgentToolOutput> => {
      const agentId = `agent-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
      const taskId = `agent-task:${agentId}`;
      const createdAt = Date.now();
      const taskManager = getAgentTaskManager();
      const agentName = input.subagent_type || "general-purpose";
      const outputFile = await ensureAgentTaskOutputFile({
        sessionId: actorSystem.sessionId,
        taskId,
        agentName,
        title: input.description,
        description: input.description,
        prompt: input.prompt,
      });
      taskManager.upsertTask(buildAgentTask({
        taskId,
        sessionId: actorSystem.sessionId,
        agentId,
        agentName,
        description: input.description,
        prompt: input.prompt,
        parentActorId: context.actorId,
        status: "queued",
        outputFile,
        subagentType: input.subagent_type,
        model: input.model,
      }));

      const agent = await actorSystem.spawnAgent({
        agentId,
        agentName,
        initialPrompt: input.prompt,
        parentActorId: context.actorId,
        subagentType: input.subagent_type,
        description: input.description,
        model: input.model,
      });
      const initialResumeContext = enrichContextWithActorSnapshot({
        taskId,
        sessionId: actorSystem.sessionId,
        agentId,
        agentName,
        createdAt,
        description: input.description,
        subagentType: input.subagent_type,
        parentActorId: context.actorId,
        model: input.model,
        originalPrompt: input.prompt,
        lastMessage: input.prompt,
        outputFile,
        pendingMessages: [],
      }, agent.actor);
      getAgentResumeService().saveContext(initialResumeContext);
      await persistTranscriptActorResumeMetadata(
        actorSystem.sessionId,
        agentId,
        buildResumeMetadata(initialResumeContext),
      ).catch(() => undefined);
      getBackgroundAgentRegistry().register({
        taskId,
        agentId,
        sessionId: actorSystem.sessionId,
        agentName,
        description: input.description,
        prompt: input.prompt,
        subagentType: input.subagent_type,
        parentActorId: context.actorId,
        model: input.model,
        status: "queued",
        startedAt: Date.now(),
        lastActiveAt: Date.now(),
        outputFile,
      });

      if (input.run_in_background) {
        taskManager.updateTask(taskId, {
          status: "running",
          startedAt: Date.now(),
          lastActiveAt: Date.now(),
          recentActivitySummary: `Agent ${input.description} 已在后台启动`,
          outputFile,
        });
        getBackgroundAgentRegistry().update(taskId, {
          status: "running",
          lastActiveAt: Date.now(),
        });
        executeAgentAsync(agent, {
          taskId,
          outputFile,
          baseContext: initialResumeContext,
          sessionId: actorSystem.sessionId,
          agentId,
          taskManager,
        }, input.prompt);
        return {
          success: true,
          agent_id: agentId,
          task_id: taskId,
          message: `Agent ${input.description} started in background`,
          output_file: outputFile,
          resumable: true,
        };
      }

      await executeAgent(agent, {
        taskId,
        outputFile,
        baseContext: initialResumeContext,
        sessionId: actorSystem.sessionId,
        agentId,
        taskManager,
      }, input.prompt);

      return {
        success: true,
        agent_id: agentId,
        task_id: taskId,
        message: `Agent ${input.description} completed`,
        output_file: outputFile,
        resumable: true,
      };
    },
  };
}
