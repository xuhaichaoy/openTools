import type { AgentTaskStatus } from './agent-task-types';

export interface LocalAgentTaskOptions {
  taskId: string;
  agentId: string;
  agentName?: string;
  prompt: string;
  parentTaskId?: string;
  background?: boolean;
}

export class LocalAgentTask {
  readonly taskId: string;
  readonly agentId: string;
  readonly agentName?: string;
  readonly prompt: string;
  readonly parentTaskId?: string;
  readonly background: boolean;
  readonly createdAt: number;

  private _status: AgentTaskStatus = 'queued';
  private _result?: unknown;
  private _error?: Error;
  private _outputFile?: string;
  private _progress?: string;

  constructor(options: LocalAgentTaskOptions) {
    this.taskId = options.taskId;
    this.agentId = options.agentId;
    this.agentName = options.agentName;
    this.prompt = options.prompt;
    this.parentTaskId = options.parentTaskId;
    this.background = options.background ?? false;
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
      status: this._status,
      background: this.background,
      createdAt: this.createdAt,
      result: this._result,
      error: this._error?.message,
      outputFile: this._outputFile,
      progress: this._progress,
    };
  }
}
