import type { ActorSystem, SpawnedAgentHandle } from '../actor/actor-system';
import { TeamRegistry } from './team-registry';
import { TeamMailbox } from './team-mailbox';
import { InProcessTeammateTask } from '../../task-center/in-process-teammate-task';
import { AgentTaskManager } from '../../task-center/agent-task-manager';

export interface InProcessRunnerOptions {
  actorSystem: ActorSystem;
  teamId: string;
  agentName: string;
  prompt: string;
  parentActorId?: string;
}

export class InProcessRunner {
  private readonly actorSystem: ActorSystem;
  private readonly teamId: string;
  private readonly agentName: string;
  private readonly prompt: string;
  private readonly parentActorId?: string;
  private actor?: SpawnedAgentHandle;
  private task?: InProcessTeammateTask;

  constructor(options: InProcessRunnerOptions) {
    this.actorSystem = options.actorSystem;
    this.teamId = options.teamId;
    this.agentName = options.agentName;
    this.prompt = options.prompt;
    this.parentActorId = options.parentActorId;
  }

  async start(): Promise<InProcessTeammateTask> {
    const registry = TeamRegistry.getInstance();
    const team = registry.getTeam(this.teamId);

    if (!team) {
      throw new Error(`Team ${this.teamId} not found`);
    }

    // Create task
    const taskManager = AgentTaskManager.getInstance();
    const agentId = `${this.teamId}-${this.agentName}-${Date.now()}`;

    this.task = new InProcessTeammateTask({
      taskId: `task-${agentId}`,
      agentId,
      agentName: this.agentName,
      prompt: this.prompt,
      teamId: this.teamId,
      parentTaskId: this.parentActorId,
    });

    taskManager.registerTask(this.task);

    // Spawn actor
    this.actor = await this.actorSystem.spawnAgent({
      agentId,
      agentName: this.agentName,
      initialPrompt: this.prompt,
      parentActorId: this.parentActorId,
    });

    this.task.setStatus('running');

    // Start execution
    this.executeAsync();

    return this.task;
  }

  private async executeAsync(): Promise<void> {
    if (!this.actor || !this.task) {
      return;
    }

    try {
      // Process mailbox messages
      await this.processMailbox();

      // Execute agent
      const result = await this.actor.execute(this.prompt);

      this.task.setResult(result);
      this.task.setStatus('completed');
    } catch (error) {
      this.task.setError(error as Error);
      this.task.setStatus('failed');
    }
  }

  private async processMailbox(): Promise<void> {
    const mailbox = TeamMailbox.getInstance();
    const messages = mailbox.getMessagesForRecipient(this.agentName, this.teamId);

    for (const msg of messages) {
      if (this.actor && msg.status === 'queued') {
        await this.actor.receiveMessage({
          from: msg.senderActorId,
          content: msg.content,
          timestamp: msg.timestamp,
        });
        mailbox.update(msg.id, { status: 'sent' });
      }
    }
  }

  async stop(): Promise<void> {
    if (this.actor) {
      await this.actor.stop();
    }
  }

  getTask(): InProcessTeammateTask | undefined {
    return this.task;
  }
}
