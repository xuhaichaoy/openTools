import type { ToolDefinition } from "../actor/types";
import type { ActorSystem } from "../actor/actor-system";
import { getAgentTaskManager } from "@/core/task-center";
import { getAgentResumeService } from "../actor/agent-resume-service";

export const SEND_MESSAGE_TOOL_NAME = "send_message";

export interface SendMessageInput {
  to: string;
  message: string;
  summary?: string;
}

export interface SendMessageOutput {
  success: boolean;
  message: string;
  routing?: {
    sender: string;
    target: string;
    summary?: string;
  };
}

export function createSendMessageTool(actorSystem: ActorSystem): ToolDefinition {
  return {
    name: SEND_MESSAGE_TOOL_NAME,
    description: "Send a message to a teammate, agent, or broadcast to all teammates",
    inputSchema: {
      type: "object",
      properties: {
        to: {
          type: "string",
          description: "Recipient: teammate name, agent ID, or '*' for broadcast",
        },
        message: {
          type: "string",
          description: "Message content",
        },
        summary: {
          type: "string",
          description: "Optional 5-10 word summary",
        },
      },
      required: ["to", "message"],
    },
    handler: async (input: SendMessageInput, context): Promise<SendMessageOutput> => {
      const { to, message, summary } = input;
      const sender = context.actorId || "user";
      const senderName = context.actorId || "leader";
      const taskManager = getAgentTaskManager();
      const resumeService = getAgentResumeService();

      if (to === "*") {
        actorSystem.broadcast(sender, message);
        return {
          success: true,
          message: "Message broadcast to all active teammates",
          routing: {
            sender: senderName,
            target: "@team",
            summary,
          },
        };
      }

      const targetActor = actorSystem.findActorByIdOrName(to);
      if (targetActor) {
        if (targetActor.status === "running") {
          actorSystem.send(sender, targetActor.id, message, {
            bypassPlanCheck: true,
          });
          const task = taskManager.list({ actorId: targetActor.id })
            .find((item) => item.targetActorId === targetActor.id);
          if (task) {
            taskManager.updateTask(task.taskId, {
              pendingMessageCount: (task.pendingMessageCount ?? 0) + 1,
              lastActiveAt: Date.now(),
              recentActivitySummary: `收到来自 ${senderName} 的续消息`,
            });
          }
          return {
            success: true,
            message: `Message queued for ${targetActor.role.name}`,
            routing: {
              sender: senderName,
              target: targetActor.role.name,
              summary,
            },
          };
        }

        const resumableContext = resumeService.getContext(targetActor.id)
          ?? resumeService.getContext(targetActor.role.name);
        if (resumableContext) {
          const resumed = await resumeService.resume({
            actorSystem,
            identifier: targetActor.id,
            message,
          });
          return {
            success: true,
            message: resumed.started
              ? `Agent "${targetActor.role.name}" resumed in background with your message. Output: ${resumed.outputFile}`
              : `Agent "${targetActor.role.name}" is already resuming; queued your message. Output: ${resumed.outputFile}`,
            routing: {
              sender: senderName,
              target: targetActor.role.name,
              summary,
            },
          };
        }

        void targetActor.assignTask(message, undefined, { publishResult: false }).catch(() => {});
        const task = taskManager.list({ actorId: targetActor.id })
          .find((item) => item.targetActorId === targetActor.id);
        if (task) {
          taskManager.updateTask(task.taskId, {
            status: "running",
            lastActiveAt: Date.now(),
            recentActivitySummary: `Agent 已恢复并收到来自 ${senderName} 的消息`,
            pendingMessageCount: 0,
          });
        }
        return {
          success: true,
          message: `Agent "${targetActor.role.name}" resumed with your message`,
          routing: {
            sender: senderName,
            target: targetActor.role.name,
            summary,
          },
        };
      }

      const resumableContext = resumeService.getContext(to);
      if (resumableContext) {
        const resumed = await resumeService.resume({
          actorSystem,
          identifier: to,
          message,
        });
        const targetName = resumableContext.agentName || to;
        return {
          success: true,
          message: resumed.started
            ? `Agent "${targetName}" resumed from saved context in background. Output: ${resumed.outputFile}`
            : `Agent "${targetName}" is already resuming; queued your message. Output: ${resumed.outputFile}`,
          routing: {
            sender: senderName,
            target: targetName,
            summary,
          },
        };
      }

      try {
        const resumed = await resumeService.resume({
          actorSystem,
          identifier: to,
          message,
        });
        return {
          success: true,
          message: resumed.started
            ? `Agent "${resumed.agentName}" resumed from persisted context in background. Output: ${resumed.outputFile}`
            : `Agent "${resumed.agentName}" is already resuming; queued your message. Output: ${resumed.outputFile}`,
          routing: {
            sender: senderName,
            target: resumed.agentName,
            summary,
          },
        };
      } catch (error) {
        const errorMessage = error instanceof Error ? error.message : String(error);
        if (!errorMessage.includes("未找到可恢复的 agent")) {
          throw error;
        }
      }

      throw new Error(`未找到可发送的 agent 或 teammate：${to}`);
    },
  };
}
