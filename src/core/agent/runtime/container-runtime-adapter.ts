import { invoke } from "@tauri-apps/api/core";
import type {
  ContainerRuntimeAvailability,
  RuntimeAdapter,
  RuntimeExecutionContext,
  RuntimeShellResult,
  RuntimeWriteResult,
} from "./types";

export class ContainerRuntimeAdapter implements RuntimeAdapter {
  readonly name = "container" as const;

  async getAvailability(): Promise<ContainerRuntimeAvailability> {
    return invoke<ContainerRuntimeAvailability>("agent_container_available");
  }

  async isAvailable() {
    const result = await this.getAvailability();
    return result.available;
  }

  async runShellCommand(
    command: string,
    context?: RuntimeExecutionContext,
  ) {
    const result = await invoke<RuntimeShellResult>("agent_container_run_shell", {
      command,
      allowedRoots: context?.allowedRoots || [],
    });
    return result;
  }

  async writeTextFile(
    path: string,
    content: string,
    context?: RuntimeExecutionContext,
  ) {
    const result = await invoke<RuntimeWriteResult>("agent_container_write_file", {
      path,
      content,
      allowedRoots: context?.allowedRoots || [],
    });
    return result;
  }
}
