import type {
  ExecutionPolicy,
  MiddlewareOverrides,
  ThinkingLevel,
  ToolPolicy,
} from "./types";

export type DialogRoutingMode = "coordinator" | "smart" | "broadcast";

export interface DialogPreset {
  id: string;
  name: string;
  description: string;
  participants: DialogPresetParticipant[];
  suggestedTopic?: string;
  defaultRoutingMode?: DialogRoutingMode;
  requirePlanApproval?: boolean;
}

export interface DialogPresetParticipant {
  customName: string;
  suggestedModel?: string;
  suggestedCapabilities?: string[];
  systemPromptOverride?: string;
  workspace?: string;
  toolPolicy?: ToolPolicy;
  executionPolicy?: ExecutionPolicy;
  middlewareOverrides?: MiddlewareOverrides;
  timeoutSeconds?: number;
  contextTokens?: number;
  thinkingLevel?: ThinkingLevel;
}

const READ_ONLY_POLICY: ToolPolicy = {
  deny: [
    "write_file",
    "str_replace_edit",
    "json_edit",
    "delete_file",
    "run_shell_command",
    "persistent_shell",
    "native_*",
    "database_execute",
    "ssh_*",
  ],
};

const CODER_POLICY: ToolPolicy = {
  deny: ["delete_file", "native_*", "ssh_*"],
};

const READ_ONLY_EXECUTION_POLICY: ExecutionPolicy = {
  accessMode: "read_only",
  approvalMode: "permissive",
};

const CODER_EXECUTION_POLICY: ExecutionPolicy = {
  accessMode: "auto",
  approvalMode: "normal",
};

const SAFE_APPROVALS: MiddlewareOverrides = {
  approvalLevel: "permissive",
};

const NORMAL_APPROVALS: MiddlewareOverrides = {
  approvalLevel: "normal",
};

// ── Preset: Code Review Discussion ──

const CODE_REVIEW_PARTICIPANTS: DialogPresetParticipant[] = [
  {
    customName: "Code Reviewer",
    suggestedCapabilities: ["coordinator", "code_review", "code_analysis"],
    toolPolicy: READ_ONLY_POLICY,
    executionPolicy: READ_ONLY_EXECUTION_POLICY,
    middlewareOverrides: SAFE_APPROVALS,
    contextTokens: 12000,
    thinkingLevel: "medium",
    systemPromptOverride: `你是一位严谨的代码审查专家，担任此次 Review 的协调者。

职责：
1. 收到用户的 Review 请求后，用 spawn_task 将"代码设计意图分析"派发给 Senior Developer
2. 自己负责审查代码质量（bug、安全、性能、可读性）
3. 子任务结果会自动回送到你的收件箱，收齐后整合双方观点，给出最终审查结论

规则：观点要引用具体代码行。禁止社交客套，直接输出分析。用中文。`,
  },
  {
    customName: "Senior Developer",
    suggestedCapabilities: ["code_write", "code_analysis"],
    toolPolicy: CODER_POLICY,
    executionPolicy: CODER_EXECUTION_POLICY,
    middlewareOverrides: NORMAL_APPROVALS,
    contextTokens: 12000,
    thinkingLevel: "medium",
    systemPromptOverride: `你是一位资深开发者。

职责：接收 spawn_task 派发的任务后，从开发者角度分析代码设计意图和实现选择。结果会自动回送给委派方。
如果 Reviewer 指出的问题确实存在，提供具体的修复代码。

规则：主动阅读被讨论的代码。禁止社交客套，直接输出分析。用中文。`,
  },
];

// ── Preset: Architecture Review ──

const ARCHITECTURE_REVIEW_PARTICIPANTS: DialogPresetParticipant[] = [
  {
    customName: "Architect",
    suggestedCapabilities: ["coordinator", "architecture"],
    toolPolicy: READ_ONLY_POLICY,
    executionPolicy: READ_ONLY_EXECUTION_POLICY,
    middlewareOverrides: SAFE_APPROVALS,
    contextTokens: 14000,
    thinkingLevel: "high",
    systemPromptOverride: `你是一位软件架构师，担任此次评审的协调者。

职责：
1. 收到评审请求后，用 spawn_task 分别派发安全评估给 Security Expert、性能评估给 Performance Engineer
2. 自己负责分析系统整体架构、模块划分、可扩展性
3. 子任务结果会自动回送，收齐后整合输出最终的架构评审报告

禁止社交客套，直接输出分析。用中文。`,
  },
  {
    customName: "Security Expert",
    suggestedCapabilities: ["security"],
    toolPolicy: READ_ONLY_POLICY,
    executionPolicy: READ_ONLY_EXECUTION_POLICY,
    middlewareOverrides: SAFE_APPROVALS,
    contextTokens: 10000,
    systemPromptOverride: `你是一位安全专家。

职责：接收 spawn_task 派发的安全评估任务，直接执行。结果会自动回送给委派方。
评估方向：安全漏洞、认证授权、数据保护等。

禁止社交客套，直接输出分析。用中文。`,
  },
  {
    customName: "Performance Engineer",
    suggestedCapabilities: ["performance"],
    toolPolicy: READ_ONLY_POLICY,
    executionPolicy: READ_ONLY_EXECUTION_POLICY,
    middlewareOverrides: SAFE_APPROVALS,
    contextTokens: 10000,
    systemPromptOverride: `你是一位性能工程师。

职责：接收 spawn_task 派发的性能评估任务，直接执行。结果会自动回送给委派方。
评估方向：性能瓶颈、缓存策略、数据库查询、并发处理等。

禁止社交客套，直接输出分析。用中文。`,
  },
];

// ── Preset: Brainstorming ──

const BRAINSTORMING_PARTICIPANTS: DialogPresetParticipant[] = [
  {
    customName: "Creative Thinker",
    suggestedCapabilities: ["coordinator", "creative"],
    toolPolicy: READ_ONLY_POLICY,
    executionPolicy: READ_ONLY_EXECUTION_POLICY,
    middlewareOverrides: SAFE_APPROVALS,
    thinkingLevel: "high",
    systemPromptOverride: `你是一位富有创造力的思考者，担任此次头脑风暴的协调者。

职责：
1. 收到讨论话题后，用 spawn_task 让 Devil's Advocate 准备反面论点，让 Synthesizer 准备整合框架
2. 自己负责提出大胆、新颖的想法
3. 子任务结果自动回送，收齐后整合输出最终方案

禁止社交客套。用中文。`,
  },
  {
    customName: "Devil's Advocate",
    suggestedCapabilities: ["creative", "code_analysis"],
    toolPolicy: READ_ONLY_POLICY,
    executionPolicy: READ_ONLY_EXECUTION_POLICY,
    middlewareOverrides: SAFE_APPROVALS,
    thinkingLevel: "medium",
    systemPromptOverride: `你是一位"魔鬼代言人"。

职责：接收 spawn_task 派发的任务后，对讨论中的想法提出质疑、反面论点和边缘情况。结果会自动回送。
目的不是否定一切，而是通过质疑让好想法更加完善。

禁止社交客套。用中文。`,
  },
  {
    customName: "Synthesizer",
    suggestedCapabilities: ["synthesis"],
    toolPolicy: READ_ONLY_POLICY,
    executionPolicy: READ_ONLY_EXECUTION_POLICY,
    middlewareOverrides: SAFE_APPROVALS,
    contextTokens: 12000,
    systemPromptOverride: `你是一位综合分析者。

职责：接收 spawn_task 派发的任务后，整合所有观点，找出共性和互补点，输出结构化的可执行方案。结果会自动回送。

禁止社交客套。用中文。`,
  },
];

// ── Preset: Debug Session ──

const DEBUG_SESSION_PARTICIPANTS: DialogPresetParticipant[] = [
  {
    customName: "Debugger",
    suggestedCapabilities: ["coordinator", "debugging", "code_analysis"],
    toolPolicy: READ_ONLY_POLICY,
    executionPolicy: READ_ONLY_EXECUTION_POLICY,
    middlewareOverrides: SAFE_APPROVALS,
    contextTokens: 12000,
    thinkingLevel: "high",
    systemPromptOverride: `你是一位调试专家，担任此次调试的协调者。

职责：
1. 收到调试请求后，先自己分析错误日志和代码，定位 bug 根因
2. 定位到根因后，用 spawn_task 将修复任务派发给 Fixer，附上问题描述和相关文件
3. 修复结果会自动回送，验证后向用户输出最终报告

禁止社交客套，直接输出分析。用中文。`,
  },
  {
    customName: "Fixer",
    suggestedCapabilities: ["code_write", "testing"],
    toolPolicy: CODER_POLICY,
    executionPolicy: CODER_EXECUTION_POLICY,
    middlewareOverrides: NORMAL_APPROVALS,
    timeoutSeconds: 600,
    contextTokens: 12000,
    systemPromptOverride: `你是一位修复专家。

职责：接收 spawn_task 派发的修复任务，编写修复代码并验证（lint、测试等）。结果会自动回送给委派方。

禁止社交客套，直接输出修复内容。用中文。`,
  },
];

// ── Export ──

export const DIALOG_PRESETS: DialogPreset[] = [
  {
    id: "code_review",
    name: "Code Review 讨论",
    description: "Reviewer + Senior Dev 互相讨论代码质量",
    participants: CODE_REVIEW_PARTICIPANTS,
    suggestedTopic: "请 review 以下代码：",
    defaultRoutingMode: "coordinator",
    requirePlanApproval: true,
  },
  {
    id: "architecture_review",
    name: "架构评审",
    description: "Architect + Security Expert + Performance Engineer 三方评审",
    participants: ARCHITECTURE_REVIEW_PARTICIPANTS,
    suggestedTopic: "请评审以下模块的架构设计：",
    defaultRoutingMode: "coordinator",
    requirePlanApproval: true,
  },
  {
    id: "brainstorming",
    name: "头脑风暴",
    description: "Creative Thinker + Devil's Advocate + Synthesizer",
    participants: BRAINSTORMING_PARTICIPANTS,
    suggestedTopic: "让我们讨论一下：",
    defaultRoutingMode: "coordinator",
  },
  {
    id: "debug_session",
    name: "代码调试",
    description: "Debugger + Fixer 协作调试",
    participants: DEBUG_SESSION_PARTICIPANTS,
    suggestedTopic: "请帮我调试以下问题：",
    defaultRoutingMode: "coordinator",
    requirePlanApproval: true,
  },
];

export function getDialogPreset(id: string): DialogPreset | undefined {
  return DIALOG_PRESETS.find((p) => p.id === id);
}

// ── 动态预设：本地存储 ──

const CUSTOM_PRESETS_KEY = "mtools-dialog-custom-presets";

export function loadCustomPresets(): DialogPreset[] {
  try {
    const stored = localStorage.getItem(CUSTOM_PRESETS_KEY);
    if (!stored) return [];
    return JSON.parse(stored) as DialogPreset[];
  } catch {
    return [];
  }
}

export function saveCustomPreset(preset: DialogPreset): void {
  const existing = loadCustomPresets();
  const idx = existing.findIndex((p) => p.id === preset.id);
  if (idx >= 0) {
    existing[idx] = preset;
  } else {
    existing.push(preset);
  }
  localStorage.setItem(CUSTOM_PRESETS_KEY, JSON.stringify(existing));
}

export function deleteCustomPreset(id: string): void {
  const existing = loadCustomPresets();
  const filtered = existing.filter((p) => p.id !== id);
  localStorage.setItem(CUSTOM_PRESETS_KEY, JSON.stringify(filtered));
}

export function exportCustomPresets(): string {
  return JSON.stringify(loadCustomPresets(), null, 2);
}

export function importCustomPresets(json: string): DialogPreset[] {
  try {
    const imported = JSON.parse(json) as DialogPreset[];
    const existing = loadCustomPresets();
    const existingIds = new Set(existing.map((p) => p.id));
    const newPresets = imported.filter((p) => !existingIds.has(p.id));
    const merged = [...existing, ...newPresets];
    localStorage.setItem(CUSTOM_PRESETS_KEY, JSON.stringify(merged));
    return newPresets;
  } catch {
    return [];
  }
}
