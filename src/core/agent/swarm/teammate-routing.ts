export interface RoutingTeammate {
  id: string;
  name: string;
  actorId?: string;
  actorName?: string;
  aliases?: string[];
}

export interface TeammateRouteMatch<T extends RoutingTeammate> {
  teammate: T;
  matchType: "exact" | "partial";
}

export interface TeammateRouteError {
  error: string;
  candidates?: string[];
}

function normalizeRoutingText(value: string): string {
  return value.trim().toLowerCase().replace(/\s+/g, " ");
}

function collectRoutingKeys(teammate: RoutingTeammate): string[] {
  return [
    teammate.id,
    teammate.name,
    teammate.actorId,
    teammate.actorName,
    ...(teammate.aliases ?? []),
  ]
    .map((value) => normalizeRoutingText(String(value ?? "")))
    .filter(Boolean);
}

function dedupeTeammates<T extends RoutingTeammate>(teammates: T[]): T[] {
  const seen = new Set<string>();
  const result: T[] = [];
  for (const teammate of teammates) {
    if (seen.has(teammate.id)) continue;
    seen.add(teammate.id);
    result.push(teammate);
  }
  return result;
}

export function resolveTeammateRoute<T extends RoutingTeammate>(
  teammates: readonly T[],
  query: string,
): TeammateRouteMatch<T> | TeammateRouteError {
  const normalizedQuery = normalizeRoutingText(query);
  if (!normalizedQuery) {
    return { error: "teammate 不能为空" };
  }

  const exactMatches = dedupeTeammates(
    teammates.filter((teammate) => collectRoutingKeys(teammate).includes(normalizedQuery)),
  );
  if (exactMatches.length === 1) {
    return {
      teammate: exactMatches[0],
      matchType: "exact",
    };
  }
  if (exactMatches.length > 1) {
    return {
      error: `teammate "${query}" 命中多个成员：${exactMatches.map((item) => item.name).join("、")}`,
      candidates: exactMatches.map((item) => item.name),
    };
  }

  const partialMatches = dedupeTeammates(
    teammates.filter((teammate) =>
      collectRoutingKeys(teammate).some((candidate) =>
        candidate.startsWith(normalizedQuery) || candidate.includes(normalizedQuery)
      )),
  );
  if (partialMatches.length === 1) {
    return {
      teammate: partialMatches[0],
      matchType: "partial",
    };
  }
  if (partialMatches.length > 1) {
    return {
      error: `teammate "${query}" 匹配不唯一：${partialMatches.map((item) => item.name).join("、")}`,
      candidates: partialMatches.map((item) => item.name),
    };
  }

  return {
    error: `未找到 teammate "${query}"`,
    candidates: teammates.map((item) => item.name),
  };
}

export function routeMessageToTeammate(params: {
  teamId: string;
  fromAgentId: string;
  toAgentId: string;
  message: string;
  summary?: string;
}): string {
  const messageId = `msg-${Date.now()}-${Math.random().toString(36).slice(2, 9)}`;
  // TODO: Implement actual message routing via mailbox
  return messageId;
}
