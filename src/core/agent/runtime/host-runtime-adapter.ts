import { invoke } from "@tauri-apps/api/core";
import type {
  RuntimeAdapter,
  RuntimeExecutionContext,
  RuntimeShellResult,
  RuntimeWriteResult,
} from "./types";

export class HostRuntimeAdapter implements RuntimeAdapter {
  readonly name = "host" as const;

  async isAvailable() {
    return true;
  }

  async runShellCommand(command: string, context?: RuntimeExecutionContext) {
    void context;
    const result = await invoke<RuntimeShellResult>("run_shell_command", { command });
    return result;
  }

  async writeTextFile(
    path: string,
    content: string,
    context?: RuntimeExecutionContext,
  ) {
    void context;
    const result = await invoke<RuntimeWriteResult>("write_text_file", {
      path,
      content,
    });
    return result;
  }
}
