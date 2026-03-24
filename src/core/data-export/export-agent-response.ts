import type { ExportAgentDecision, StructuredExportIntent } from "./types";

function normalizeDecision(raw: unknown): ExportAgentDecision {
  if (!raw || typeof raw !== "object") {
    throw new Error("导出 Agent 未返回有效对象");
  }

  const result = raw as Record<string, unknown>;
  const kind = String(result.kind ?? "").trim();

  if (kind === "clarify") {
    const question = String(result.question ?? "").trim();
    if (!question) {
      throw new Error("导出 Agent 缺少澄清问题");
    }
    return { kind, question };
  }

  if (kind === "answer") {
    const answer = String(result.answer ?? result.text ?? "").trim();
    if (!answer) {
      throw new Error("导出 Agent 缺少回答内容");
    }
    return { kind, answer };
  }

  if (kind === "reject") {
    const reason = String(result.reason ?? "").trim() || "当前请求暂不支持自动导出。";
    return { kind, reason };
  }

  if (kind !== "intent") {
    throw new Error(`导出 Agent 返回了未知 kind: ${kind || "(empty)"}`);
  }

  const intent = result.intent as Record<string, unknown> | undefined;
  if (!intent) {
    throw new Error("导出 Agent 缺少 intent");
  }

  const sourceId = String(intent.sourceId ?? "").trim();
  const entityName = String(intent.entityName ?? "").trim();
  if (!sourceId || !entityName) {
    throw new Error("导出 Agent 返回的 intent 缺少 sourceId 或 entityName");
  }

  const normalizedIntent: StructuredExportIntent = {
    sourceId,
    ...(intent.sourceScope === "team" ? { sourceScope: "team" as const } : {}),
    ...(typeof intent.teamId === "string" && intent.teamId.trim()
      ? { teamId: intent.teamId.trim() }
      : {}),
    ...(typeof intent.datasetId === "string" && intent.datasetId.trim()
      ? { datasetId: intent.datasetId.trim() }
      : {}),
    entityName,
    ...(typeof intent.entityType === "string"
      ? { entityType: intent.entityType as StructuredExportIntent["entityType"] }
      : {}),
    ...(typeof intent.schema === "string" && intent.schema.trim()
      ? { schema: intent.schema.trim() }
      : {}),
    ...(typeof intent.baseAlias === "string" && intent.baseAlias.trim()
      ? { baseAlias: intent.baseAlias.trim() }
      : {}),
    ...(Array.isArray(intent.fields)
      ? {
          fields: intent.fields
            .map((item) => {
              if (typeof item === "string") {
                const field = item.trim();
                return field ? field : null;
              }
              if (!item || typeof item !== "object") return null;
              const rawField = item as Record<string, unknown>;
              const field = String(rawField.field ?? "").trim();
              if (!field) return null;
              const alias = String(rawField.alias ?? "").trim();
              return alias ? { field, alias } : { field };
            })
            .filter((item): item is NonNullable<typeof item> => Boolean(item)),
        }
      : {}),
    ...(Array.isArray(intent.joins)
      ? {
          joins: intent.joins
            .filter((item) => item && typeof item === "object")
            .map((item) => {
              const rawJoin = item as Record<string, unknown>;
              const entityName = String(rawJoin.entityName ?? "").trim();
              if (!entityName) return null;
              const on = Array.isArray(rawJoin.on)
                ? rawJoin.on
                  .filter((condition) => condition && typeof condition === "object")
                  .map((condition) => {
                    const rawCondition = condition as Record<string, unknown>;
                    const left = String(rawCondition.left ?? "").trim();
                    const right = String(rawCondition.right ?? "").trim();
                    if (!left || !right) return null;
                    const op = String(rawCondition.op ?? "").trim();
                    return op ? { left, right, op } : { left, right };
                  })
                  .filter((condition): condition is NonNullable<typeof condition> => Boolean(condition))
                : [];
              if (on.length === 0) return null;
              const join = {
                entityName,
                ...(typeof rawJoin.entityType === "string" && rawJoin.entityType.trim()
                  ? { entityType: rawJoin.entityType.trim() as StructuredExportIntent["entityType"] }
                  : {}),
                ...(typeof rawJoin.schema === "string" && rawJoin.schema.trim()
                  ? { schema: rawJoin.schema.trim() }
                  : {}),
                ...(typeof rawJoin.alias === "string" && rawJoin.alias.trim()
                  ? { alias: rawJoin.alias.trim() }
                  : {}),
                ...(typeof rawJoin.joinType === "string" && rawJoin.joinType.trim()
                  ? { joinType: rawJoin.joinType.trim().toLowerCase() as "inner" | "left" | "right" }
                  : {}),
                on,
              };
              return join;
            })
            .filter((item): item is NonNullable<typeof item> => Boolean(item)),
        }
      : {}),
    ...(Array.isArray(intent.filters)
      ? {
          filters: intent.filters
            .filter((item) => item && typeof item === "object")
            .map((item) => {
              const rawFilter = item as Record<string, unknown>;
              return {
                field: String(rawFilter.field ?? "").trim(),
                op: String(rawFilter.op ?? "eq").trim(),
                value: rawFilter.value ?? null,
              };
            })
            .filter((item) => item.field),
        }
      : {}),
    ...(Array.isArray(intent.sort)
      ? {
          sort: intent.sort
            .filter((item) => item && typeof item === "object")
            .map((item) => {
              const rawSort = item as Record<string, unknown>;
              return {
                field: String(rawSort.field ?? "").trim(),
                direction:
                  String(rawSort.direction ?? "asc").trim().toLowerCase() === "desc"
                    ? "desc"
                    : "asc",
              } as const;
            })
            .filter((item) => item.field),
        }
      : {}),
    ...(typeof intent.limit === "number" && Number.isFinite(intent.limit) && intent.limit > 0
      ? { limit: Math.floor(intent.limit) }
      : {}),
    outputFormat: "csv",
  };

  return {
    kind,
    intent: normalizedIntent,
    ...(typeof result.summary === "string" && result.summary.trim()
      ? { summary: result.summary.trim() }
      : {}),
  };
}

function unwrapMarkdownFence(text: string): string {
  const trimmed = text.trim();
  const fencedMatch = trimmed.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/i);
  if (fencedMatch?.[1]) {
    return fencedMatch[1].trim();
  }
  return trimmed;
}

export function isExportMetadataQuestion(text?: string | null): boolean {
  const normalized = String(text ?? "").trim().toLowerCase();
  if (!normalized) return false;
  return [
    /(?:目前|当前|现在|都)?(?:能|可)?(?:读取|读到|访问|查看|看到).{0,12}(?:哪些|什么|多少).{0,8}(?:库|database|schema|表|table|tables|字段|数据源)/u,
    /(?:哪些|什么|多少).{0,8}(?:库|database|schema|表|table|tables|字段|数据源).{0,12}(?:能|可)?(?:读取|读到|访问|查看|看到)/u,
    /(?:目前|当前|现在).{0,12}(?:有哪些|有哪几个|有多少).{0,8}(?:库|database|schema|表|table|tables|数据源)/u,
    /(?:有哪些|有哪几个|有多少).{0,8}(?:库|database|schema|表|table|tables|字段|数据源).{0,12}(?:可以查|可查|能查|可读|能读|可用)/u,
    /(?:列出|展示|告诉我).{0,8}(?:可读|可用|能读|可访问).{0,8}(?:库|database|schema|表|table|tables|数据源)/u,
    /(?:是否有|有没有|有无|在不在|存在(?:吗)?).{0,24}(?:库|database|schema|表|table|tables|字段|数据源)/u,
    /(?:库|database|schema|表|table|tables|字段|数据源).{0,12}(?:是否有|有没有|有无|在不在|存在(?:吗)?)/u,
  ].some((pattern) => pattern.test(normalized));
}

function stripAnswerPrefix(text: string): string {
  return text
    .replace(/^(?:最终答案|answer|回答|result)[:：]\s*/iu, "")
    .trim();
}

function looksLikeClarifyQuestion(text: string): boolean {
  const normalized = stripAnswerPrefix(text);
  if (!normalized) return false;
  if (/[？?]\s*$/.test(normalized)) return true;
  return [
    /(?:请问|想确认|需要确认|你是指|还是指|请确认|麻烦确认)/u,
    /(?:需要|还需).{0,10}(?:确认|补充|说明)/u,
  ].some((pattern) => pattern.test(normalized));
}

function containsSchemaLeakMarker(text: string): boolean {
  const normalized = stripAnswerPrefix(text);
  if (!normalized) return false;
  return [
    /[a-z0-9_]+\.[a-z0-9_]+/iu,
    /(?:表名|字段名|schema|database|collection|column|columns)\b/iu,
    /(?:table|tables|field|fields)\b/iu,
    /(?:_id|_name|compname|corp_id|bus_name)\b/iu,
    /`[^`]+`/u,
  ].some((pattern) => pattern.test(normalized));
}

function classifyBusinessClarifyIntent(text: string): "company" | "order" | "user" | "generic" {
  const normalized = String(text ?? "").trim().toLowerCase();
  if (/(公司|企业|商户|客户|client|company|enterprise|merchant|corp|business)/u.test(normalized)) {
    return "company";
  }
  if (/(订单|支付|退款|交易|商品|下单|order|payment|refund|trade)/u.test(normalized)) {
    return "order";
  }
  if (/(用户|会员|账号|手机号|手机|联系人|注册|登录|user|member|account|mobile|phone|contact)/u.test(normalized)) {
    return "user";
  }
  return "generic";
}

function buildOperatorFacingClarifyQuestion(params: {
  userInput?: string | null;
  originalQuestion: string;
}): string {
  switch (classifyBusinessClarifyIntent(params.userInput ?? params.originalQuestion)) {
    case "company":
      return "我还不能稳定确认你要的是哪类企业数据。请直接告诉我你更想导出哪一种业务信息：企业基础信息、联系人/电话、推广归属，还是订单/交易相关信息。";
    case "order":
      return "我还不能稳定确认你要导出的订单口径。请直接告诉我是要订单基础信息、支付结果、退款信息，还是商品明细。";
    case "user":
      return "我还不能稳定确认你要的是哪类用户数据。请直接告诉我是要用户基础信息、联系方式、注册登录行为，还是与用户相关的订单/交易信息。";
    default:
      return "我还不能稳定定位到你要的业务口径。请直接说你想导出什么业务信息，例如“企业名称、联系人和电话”“昨天支付成功的订单”“某活动报名用户”。";
  }
}

function extractClarifyQuestion(text: string): string | null {
  const normalized = stripAnswerPrefix(text);
  if (!normalized) return null;
  const lines = normalized
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);
  const questionLine = lines.find((line) => looksLikeClarifyQuestion(line)) ?? lines[0];
  const question = questionLine?.trim();
  return question ? question : null;
}

function looksLikeRecoverableReject(text: string): boolean {
  const normalized = stripAnswerPrefix(text);
  if (!normalized) return false;
  return [
    /已达到最大执行步数/u,
    /执行已提前停止/u,
    /没有可用的数据源/u,
    /当前还没有可用的数据源/u,
    /暂不支持/u,
    /未提供.*元数据工具/u,
    /元数据工具.*不可用/u,
    /tool.*unavailable/iu,
    /无法先确认数据源/u,
    /无法(?:确认|完成|处理|导出|查询)/u,
    /未找到(?:可用)?(?:数据源|表|字段|数据集)/u,
  ].some((pattern) => pattern.test(normalized));
}

function buildRecoverableRejectReason(text: string): string {
  const normalized = stripAnswerPrefix(text);
  if (/未提供.*元数据工具|元数据工具.*不可用|tool.*unavailable|无法先确认数据源/u.test(normalized)) {
    return "这次查数没有稳定定位到业务口径。请直接说你想查哪类企业数据，例如“查询某公司的基础信息”“查询某公司的联系人和电话”“查询某公司的订单信息”。";
  }
  if (/已达到最大执行步数|执行已提前停止/u.test(normalized)) {
    return "这次导出在自动探查数据结构时没有稳定收敛。请把需求再说具体一点，例如“帮我查询某企业的联系人和电话”，或者先问“目前有哪些数据源/库可以查询”。";
  }
  return normalized || "当前请求暂不支持自动导出。";
}

export function parseExportAgentResponse(
  text: string,
  options?: { userInput?: string | null },
): ExportAgentDecision {
  const trimmed = String(text ?? "").trim();
  if (!trimmed) {
    throw new Error("导出 Agent 返回为空");
  }

  const unfenced = unwrapMarkdownFence(trimmed);
  const candidates = [unfenced];
  const start = unfenced.indexOf("{");
  const end = unfenced.lastIndexOf("}");
  if (start >= 0 && end > start) {
    candidates.push(unfenced.slice(start, end + 1));
  }

  for (const candidate of candidates) {
    try {
      return normalizeDecision(JSON.parse(candidate));
    } catch {
      continue;
    }
  }

  if (isExportMetadataQuestion(options?.userInput)) {
    const answer = stripAnswerPrefix(unfenced);
    if (answer) {
      return { kind: "answer", answer };
    }
  }

  if (looksLikeClarifyQuestion(unfenced)) {
    const question = extractClarifyQuestion(unfenced);
    if (question) {
      return {
        kind: "clarify",
        question: containsSchemaLeakMarker(question)
          ? buildOperatorFacingClarifyQuestion({
              userInput: options?.userInput,
              originalQuestion: question,
            })
          : question,
      };
    }
  }

  if (looksLikeRecoverableReject(unfenced)) {
    return {
      kind: "reject",
      reason: buildRecoverableRejectReason(unfenced),
    };
  }

  throw new Error("导出 Agent 返回不是有效 JSON");
}
