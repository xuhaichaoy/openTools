import type { AgentTaskStatus } from './agent-task-types';

export interface InProcessTeammateTaskOptions {
  taskId: string;
  agentId: string;
  agentName: string;
  prompt: string;
  teamId: string;
  parentTaskId?: string;
}

export class InProcessTeammateTask {
  readonly taskId: string;
  readonly agentId: string;
  readonly agentName: string;
  readonly prompt: string;
  readonly teamId: string;
  readonly parentTaskId?: string;
  readonly createdAt: number;

  private _status: AgentTaskStatus = 'queued';
  private _result?: unknown;
  private _error?: Error;
  private _outputFile?: string;
  private _progress?: string;

  constructor(options: InProcessTeammateTaskOptions) {
    this.taskId = options.taskId;
    this.agentId = options.agentId;
    this.agentName = options.agentName;
    this.prompt = options.prompt;
    this.teamId = options.teamId;
    this.parentTaskId = options.parentTaskId;
    this.createdAt = Date.now();
  }

  get status(): AgentTaskStatus {
    return this._status;
  }

  get result(): unknown {
    return this._result;
  }

  get error(): Error | undefined {
    return this._error;
  }

  get outputFile(): string | undefined {
    return this._outputFile;
  }

  get progress(): string | undefined {
    return this._progress;
  }

  setStatus(status: AgentTaskStatus): void {
    this._status = status;
  }

  setResult(result: unknown): void {
    this._result = result;
    this._status = 'completed';
  }

  setError(error: Error): void {
    this._error = error;
    this._status = 'failed';
  }

  setOutputFile(file: string): void {
    this._outputFile = file;
  }

  setProgress(progress: string): void {
    this._progress = progress;
  }

  toJSON() {
    return {
      taskId: this.taskId,
      agentId: this.agentId,
      agentName: this.agentName,
      teamId: this.teamId,
      status: this._status,
      createdAt: this.createdAt,
      result: this._result,
      error: this._error?.message,
      outputFile: this._outputFile,
      progress: this._progress,
    };
  }
}
