const COORDINATOR_RESULT_PROTOCOL_ITEMS = [
  "worker 的详细过程与完整终态会在后台回流；公屏上的一两句 answer 只是完成通知，不是完整交付。",
  "做最终汇总时，至少明确：完成项、关键证据、产物或验证结果、剩余 blocker / 风险。",
  "如果多个 worker 结论冲突，先补充追问、复核或再派一个验证线程，不要直接拍板。",
] as const;

const WORKER_RESULT_PROTOCOL_ITEMS = [
  "terminal result 必须给协调者真实回传：结论、关键证据、实际修改/验证、blocker。",
  "面向公屏的最终 answer 只保留一两句话进度通知，不要重复长报告。",
  "不要把计划、猜测或待验证事项包装成“已经完成”的结果。",
] as const;

export function buildCoordinatorResultProtocolPrompt(): string {
  return [
    "## Worker 结果协议",
    ...COORDINATOR_RESULT_PROTOCOL_ITEMS.map((item) => `- ${item}`),
  ].join("\n");
}

export function buildWorkerResultProtocolPrompt(): string {
  return [
    "## Worker 结果协议",
    ...WORKER_RESULT_PROTOCOL_ITEMS.map((item) => `- ${item}`),
  ].join("\n");
}

