import { buildCoordinatorResultProtocolPrompt, buildWorkerResultProtocolPrompt } from "./coordinator-result-protocol";
import { buildCoordinatorToolPoolPrompt } from "./coordinator-tool-pool";

// Global coordinator mode state
let globalCoordinatorMode = false;

export function isCoordinatorMode(): boolean {
  return globalCoordinatorMode || process.env.MTOOLS_COORDINATOR_MODE === "1";
}

export function setCoordinatorMode(enabled: boolean): void {
  globalCoordinatorMode = enabled;
  if (enabled) {
    process.env.MTOOLS_COORDINATOR_MODE = "1";
  } else {
    delete process.env.MTOOLS_COORDINATOR_MODE;
  }
}

// Worker tool whitelist - tools available to spawned workers
const WORKER_TOOL_WHITELIST = new Set([
  "spawn_task",
  "wait_for_spawned_tasks",
  "send_message",
  "read_file",
  "write_file",
  "edit_file",
  "list_files",
  "search_files",
  "execute_command",
  "read_session_history",
]);

// Internal tools only for coordinator
const COORDINATOR_ONLY_TOOLS = new Set([
  "create_team",
  "delete_team",
  "send_team_message",
]);

export function filterToolsForWorker(allTools: string[]): string[] {
  if (!isCoordinatorMode()) {
    return allTools;
  }
  return allTools.filter(tool =>
    WORKER_TOOL_WHITELIST.has(tool) && !COORDINATOR_ONLY_TOOLS.has(tool)
  );
}

export function buildCoordinatorModePrompt(params: {
  isCoordinator: boolean;
  teammateNames: string[];
  hasPlannedDelegations: boolean;
  workerToolWhitelist?: string[];
}): string {
  const teammateLabel = params.teammateNames.length > 0
    ? params.teammateNames.join("、")
    : "其他 Agent";

  if (params.isCoordinator) {
    const workerTools = params.workerToolWhitelist?.join(", ") ||
      Array.from(WORKER_TOOL_WHITELIST).sort().join(", ");

    return [
      "## 当前角色：协调者（Coordinator Mode）",
      "- 你当前不是「默认主 actor」而已，而是在显式 coordinator mode 下负责理解需求、决定是否拆分、安排 worker，并在最后整合全局结论。",
      "- 协调者优先负责判断任务是否值得并行；如果不值得拆分，就直接自己完成。",
      params.hasPlannedDelegations
        ? "- 已批准建议委派只是许可与建议，不是必须照单执行；你可以复用、改写、合并或跳过。"
        : "- 当前没有预先批准的委派清单；如果需要协作，请自己决定是否补派合适 worker。",
      `- 当前可协作对象：${teammateLabel}。如房间中没有合适角色，可直接补建临时专用 worker。`,
      `- Worker 可用工具：${workerTools}`,
      "",
      buildCoordinatorToolPoolPrompt(),
      "",
      buildCoordinatorResultProtocolPrompt(),
    ].join("\n");
  }

  return [
    "## 当前角色：执行者（Worker in Coordinator Mode）",
    "- 当前由协调者统一安排分工；你负责在本轮职责边界内完成任务，不要接管整轮协作。",
    "- 如果判断还需要额外的实现、探索、审查或验证线程，请把建议和原因回传协调者，由协调者决定是否继续派工。",
    `- 你的详细结果会自动回流给协调者 ${teammateLabel === "其他 Agent" ? "" : `（协作对象包括：${teammateLabel}）`}。`.trim(),
    "",
    buildWorkerResultProtocolPrompt(),
  ].join("\n");
}
