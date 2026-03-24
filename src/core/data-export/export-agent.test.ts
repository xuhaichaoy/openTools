import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn(),
}));

vi.mock("@tauri-apps/plugin-store", () => ({
  load: vi.fn(async () => ({
    get: vi.fn(async () => null),
    set: vi.fn(async () => undefined),
    delete: vi.fn(async () => undefined),
    save: vi.fn(async () => undefined),
  })),
}));
import {
  expandBusinessSearchKeywords,
  mergeTableSearchResults,
  resolveDeterministicExportDecision,
  resolveExportMetadataAnswer,
  resolveExplicitTableInspectionAnswer,
} from "./export-agent";
import { invoke } from "@tauri-apps/api/core";
import { useDatabaseStore } from "@/store/database-store";
import type {
  RuntimeExportDatasetDefinition,
  RuntimeExportSourceConfig,
} from "./types";

describe("export-agent metadata direct answers", () => {
  beforeEach(() => {
    useDatabaseStore.getState().clearDatabaseClientContext();
    useDatabaseStore.setState({ tableColumns: {} });
    vi.clearAllMocks();
  });

  const sources: RuntimeExportSourceConfig[] = [
    {
      id: "personal-sqlite",
      scope: "personal",
      executionTarget: "local",
      originSourceId: "personal-sqlite",
      name: "本地 SQLite",
      db_type: "sqlite",
      database: "ops_local.db",
    },
    {
      id: "team-1-source-1",
      scope: "team",
      executionTarget: "team_service",
      teamId: "team-1",
      originSourceId: "source-1",
      name: "团队 CRM",
      db_type: "mysql",
      database: "crm",
    },
  ];

  const datasets: RuntimeExportDatasetDefinition[] = [
    {
      id: "team-dataset-1",
      scope: "team",
      teamId: "team-1",
      originDatasetId: "dataset-1",
      sourceId: "team-1-source-1",
      originSourceId: "source-1",
      entityName: "edu_saas_business",
      entityType: "table",
      displayName: "企业客户信息表",
      description: "企业基础信息",
      defaultFields: ["bus_name"],
      fields: [
        {
          name: "bus_name",
          label: "企业名称",
          enabled: true,
        },
      ],
      enabled: true,
    },
  ];

  it("answers source inventory directly", async () => {
    const decision = await resolveExportMetadataAnswer({
      userInput: "目前有哪些数据源",
      sources,
      datasets,
    });

    expect(decision).toEqual({
      kind: "answer",
      answer: expect.stringContaining("当前可用数据源共 2 个。"),
    });
    expect(decision?.kind).toBe("answer");
    expect(decision && "answer" in decision ? decision.answer : "").toContain("本地 SQLite");
    expect(decision && "answer" in decision ? decision.answer : "").toContain("团队 CRM");
  });

  it("answers readable namespaces directly", async () => {
    const decision = await resolveExportMetadataAnswer({
      userInput: "目前有哪些库可以查询",
      sources,
      datasets,
    });

    expect(decision?.kind).toBe("answer");
    const answer = decision && "answer" in decision ? decision.answer : "";
    expect(answer).toContain("当前可读取的库 / schema 信息如下");
    expect(answer).toContain("本地 SQLite");
    expect(answer).toContain("ops_local.db");
    expect(answer).toContain("团队共享源当前不直接开放原始");
    expect(answer).toContain("企业客户信息表");
  });

  it("answers namespace existence follow-up directly", async () => {
    const mysqlSources: RuntimeExportSourceConfig[] = [
      {
        id: "personal-mysql",
        scope: "personal",
        executionTarget: "local",
        originSourceId: "personal-mysql",
        name: "个人 MySQL",
        db_type: "mysql",
      },
    ];

    vi.mocked(invoke).mockImplementation(async (command) => {
      if (command === "db_connect") return null;
      if (command === "db_list_schemas") {
        return ["athena_user", "athena_basis", "athena_order"];
      }
      throw new Error(`unexpected command: ${String(command)}`);
    });

    const decision = await resolveExportMetadataAnswer({
      userInput: "里面是否有 athena_user 的库",
      originalRequest: "看一下现在都有哪些库",
      sources: mysqlSources,
      datasets: [],
    });

    expect(decision).toEqual({
      kind: "answer",
      answer: expect.stringContaining("有，当前可读取的库 / schema 里包含 athena_user。"),
    });
    if (!decision || decision.kind !== "answer") {
      throw new Error("expected metadata answer");
    }
    expect(decision.answer).toContain("个人 MySQL");
    expect(decision.answer).toContain("athena_user");
  });

  it("returns null for normal export requests", async () => {
    await expect(resolveExportMetadataAnswer({
      userInput: "帮我导出昨天订单",
      sources,
      datasets,
    })).resolves.toBeNull();
  });

  it("expands company-like business keywords before table search", () => {
    const keywords = expandBusinessSearchKeywords("公司");
    expect(keywords).toContain("公司");
    expect(keywords).toContain("company");
    expect(keywords).toContain("corp");
    expect(keywords).toContain("bus_name");
  });

  it("merges duplicate table search hits across expanded keywords", () => {
    expect(mergeTableSearchResults([
      {
        name: "company",
        schema: "athena_user",
        matched_columns: ["company_id"],
      },
      {
        name: "company",
        schema: "athena_user",
        matched_columns: ["compname"],
      },
      {
        name: "promote_user",
        schema: "athena_basis",
        matched_columns: ["company_id"],
      },
    ])).toEqual([
      {
        name: "company",
        schema: "athena_user",
        matched_columns: ["company_id", "compname"],
      },
      {
        name: "promote_user",
        schema: "athena_basis",
        matched_columns: ["company_id"],
      },
    ]);
  });
});

describe("export-agent deterministic business fallback", () => {
  beforeEach(() => {
    useDatabaseStore.getState().clearDatabaseClientContext();
    useDatabaseStore.setState({ tableColumns: {} });
    vi.clearAllMocks();
  });

  const personalMysqlSource: RuntimeExportSourceConfig = {
    id: "personal-mysql",
    scope: "personal",
    executionTarget: "local",
    originSourceId: "personal-mysql",
    name: "个人 MySQL",
    db_type: "mysql",
  };

  it("builds a single-table company query without relying on model tools", async () => {
    vi.mocked(invoke).mockImplementation(async (command, args) => {
      if (command === "db_connect") return null;
      if (command === "db_search_tables") {
        const keyword = String((args as { keyword?: string }).keyword ?? "");
        if (["公司", "company", "corp", "enterprise", "bus_name", "customer"].some((token) => keyword.includes(token))) {
          return [
            {
              name: "company",
              schema: "athena_user",
              table_type: "BASE TABLE",
              matched_columns: ["compname"],
            },
          ];
        }
        return [];
      }
      if (command === "db_describe_table") {
        return [
          { name: "id", data_type: "bigint", nullable: false, primary_key: true },
          { name: "compname", data_type: "varchar", nullable: false, primary_key: false },
          { name: "status", data_type: "varchar", nullable: true, primary_key: false },
          { name: "industry", data_type: "varchar", nullable: true, primary_key: false },
          { name: "create_time", data_type: "datetime", nullable: true, primary_key: false },
        ];
      }
      return null;
    });

    const decision = await resolveDeterministicExportDecision({
      userInput: "查询 第一企kkk 这个公司的信息",
      sources: [personalMysqlSource],
      datasets: [],
    });

    expect(decision).toMatchObject({
      kind: "intent",
      summary: "我理解的是：查询该企业的基础信息。",
      intent: {
        sourceId: "personal-mysql",
        entityName: "company",
        schema: "athena_user",
        baseAlias: "c",
        filters: [
          {
            field: "c.compname",
            op: "contains_compact",
            value: "第一企kkk",
          },
        ],
      },
    });
    if (!decision || decision.kind !== "intent") {
      throw new Error("expected deterministic intent");
    }
    expect(decision.intent.fields).toContainEqual({ field: "c.compname", alias: "企业名称" });
  });

  it("builds a join query for company contact export", async () => {
    vi.mocked(invoke).mockImplementation(async (command, args) => {
      if (command === "db_connect") return null;
      if (command === "db_search_tables") {
        const keyword = String((args as { keyword?: string }).keyword ?? "");
        if (["公司", "company", "corp", "enterprise", "bus_name", "customer"].some((token) => keyword.includes(token))) {
          return [
            {
              name: "company",
              schema: "athena_user",
              table_type: "BASE TABLE",
              matched_columns: ["compname"],
            },
          ];
        }
        if (["联系人", "contact", "phone", "mobile", "wechat", "company_id"].some((token) => keyword.includes(token))) {
          return [
            {
              name: "promote_user",
              schema: "athena_basis",
              table_type: "BASE TABLE",
              matched_columns: ["company_id", "mobile"],
            },
          ];
        }
        return [];
      }
      if (command === "db_describe_table") {
        const table = String((args as { table?: string }).table ?? "");
        if (table === "athena_user.company") {
          return [
            { name: "id", data_type: "bigint", nullable: false, primary_key: true },
            { name: "compname", data_type: "varchar", nullable: false, primary_key: false },
            { name: "status", data_type: "varchar", nullable: true, primary_key: false },
            { name: "create_time", data_type: "datetime", nullable: true, primary_key: false },
          ];
        }
        if (table === "athena_basis.promote_user") {
          return [
            { name: "id", data_type: "bigint", nullable: false, primary_key: true },
            { name: "company_id", data_type: "bigint", nullable: false, primary_key: false },
            { name: "contact_name", data_type: "varchar", nullable: true, primary_key: false },
            { name: "mobile", data_type: "varchar", nullable: true, primary_key: false },
            { name: "create_time", data_type: "datetime", nullable: true, primary_key: false },
          ];
        }
        return [];
      }
      return null;
    });

    const decision = await resolveDeterministicExportDecision({
      userInput: "查询 第一企kkk 这个公司的联系人和电话",
      sources: [personalMysqlSource],
      datasets: [],
    });

    expect(decision).toMatchObject({
      kind: "intent",
      summary: "我理解的是：查询该企业的基础信息，并带出联系人与电话。",
      intent: {
        sourceId: "personal-mysql",
        entityName: "company",
        schema: "athena_user",
        baseAlias: "c",
        joins: [
          {
            entityName: "promote_user",
            schema: "athena_basis",
            alias: "u",
            joinType: "left",
            on: [
              {
                left: "c.id",
                right: "u.company_id",
                op: "eq",
              },
            ],
          },
        ],
        filters: [
          {
            field: "c.compname",
            op: "contains_compact",
            value: "第一企kkk",
          },
        ],
      },
    });
    if (!decision || decision.kind !== "intent") {
      throw new Error("expected deterministic join intent");
    }
    expect(decision.intent.fields).toContainEqual({ field: "u.contact_name", alias: "联系人" });
    expect(decision.intent.fields).toContainEqual({ field: "u.mobile", alias: "手机号" });
  });

  it("prefers the current database client table context and compacts company keyword spaces", async () => {
    useDatabaseStore.setState({
      databaseClientContext: {
        connectionId: "personal-mysql",
        connectionName: "个人 MySQL",
        dbType: "mysql",
        schema: "athena_user",
        tableKey: "athena_user.company",
        tableName: "company",
      },
      tableColumns: {
        "athena_user.company": [
          { name: "id", data_type: "bigint", nullable: false, primary_key: true },
          { name: "compname", data_type: "varchar", nullable: false, primary_key: false },
          { name: "update_time", data_type: "datetime", nullable: true, primary_key: false },
        ],
      },
    });

    vi.mocked(invoke).mockImplementation(async (command) => {
      if (command === "db_connect") return null;
      throw new Error(`unexpected command: ${String(command)}`);
    });

    const decision = await resolveDeterministicExportDecision({
      userInput: "查询 第一企 kkk 这个公司的信息",
      sources: [personalMysqlSource],
      datasets: [],
    });

    expect(decision).toMatchObject({
      kind: "intent",
      intent: {
        sourceId: "personal-mysql",
        entityName: "company",
        schema: "athena_user",
        filters: [
          {
            field: "c.compname",
            op: "contains_compact",
            value: "第一企kkk",
          },
        ],
      },
    });
  });
});

describe("export-agent dataset semantic resolution", () => {
  beforeEach(() => {
    useDatabaseStore.getState().clearDatabaseClientContext();
    useDatabaseStore.setState({ tableColumns: {} });
    vi.clearAllMocks();
  });

  const personalMysqlSource: RuntimeExportSourceConfig = {
    id: "personal-mysql",
    scope: "personal",
    executionTarget: "local",
    originSourceId: "personal-mysql",
    name: "个人 MySQL",
    db_type: "mysql",
    max_export_rows: 5000,
  };

  it("prefers semantic datasets for time-window export requests", async () => {
    const decision = await resolveDeterministicExportDecision({
      userInput: "帮我导出近30天订单前100条",
      sources: [personalMysqlSource],
      datasets: [
        {
          id: "dataset-orders",
          scope: "personal",
          sourceId: "personal-mysql",
          entityName: "orders_daily_view",
          entityType: "view",
          schema: "athena_order",
          displayName: "订单明细",
          description: "订单基础信息与金额",
          aliases: ["订单", "订单数据"],
          intentTags: ["订单导出", "订单明细"],
          keywordField: "order_no",
          timeField: "created_at",
          baseAlias: "o",
          defaultFields: ["order_no", "amount", "created_at"],
          fields: [
            { name: "order_no", label: "订单号", enabled: true },
            { name: "amount", label: "订单金额", enabled: true },
            { name: "created_at", label: "下单时间", enabled: true },
          ],
          relations: [],
          maxExportRows: 2000,
          enabled: true,
          createdAt: 1,
          updatedAt: 1,
        },
      ],
    });

    expect(decision).toMatchObject({
      kind: "intent",
      intent: {
        sourceId: "personal-mysql",
        datasetId: "dataset-orders",
        entityName: "orders_daily_view",
        schema: "athena_order",
        baseAlias: "o",
        limit: 100,
      },
    });
    if (!decision || decision.kind !== "intent") {
      throw new Error("expected dataset intent");
    }
    expect(decision.intent.fields).toContainEqual({ field: "o.order_no", alias: "订单号" });
    expect(decision.intent.filters).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ field: "o.created_at", op: "gte" }),
        expect.objectContaining({ field: "o.created_at", op: "lt" }),
      ]),
    );
  });

  it("uses configured dataset relations to build join intents", async () => {
    const decision = await resolveDeterministicExportDecision({
      userInput: "帮我导出王者荣耀企业联系人和电话",
      sources: [personalMysqlSource],
      datasets: [
        {
          id: "dataset-company",
          scope: "personal",
          sourceId: "personal-mysql",
          entityName: "company",
          entityType: "table",
          schema: "athena_user",
          displayName: "企业资料",
          description: "企业基础信息与状态",
          aliases: ["企业", "公司", "客户资料"],
          intentTags: ["企业基础信息", "客户详情"],
          keywordField: "compname",
          baseAlias: "c",
          defaultFields: ["compname", "status"],
          fields: [
            { name: "compname", label: "企业名称", aliases: ["公司名"], enabled: true },
            { name: "status", label: "状态", enabled: true },
          ],
          relations: [
            {
              id: "relation-contact",
              name: "企业联系人",
              description: "联系人和电话信息",
              targetEntityName: "promote_user",
              targetEntityType: "table",
              targetSchema: "athena_basis",
              alias: "u",
              joinType: "left",
              triggerKeywords: ["联系人", "电话", "手机"],
              on: [{ left: "c.id", op: "eq", right: "u.company_id" }],
              defaultFields: [
                { field: "contact_name", alias: "联系人" },
                { field: "mobile", alias: "手机号" },
              ],
              enabled: true,
            },
          ],
          maxExportRows: 1000,
          enabled: true,
          createdAt: 1,
          updatedAt: 1,
        },
      ],
    });

    expect(decision).toMatchObject({
      kind: "intent",
      intent: {
        sourceId: "personal-mysql",
        datasetId: "dataset-company",
        entityName: "company",
        schema: "athena_user",
        baseAlias: "c",
        joins: [
          {
            entityName: "promote_user",
            schema: "athena_basis",
            alias: "u",
            joinType: "left",
          },
        ],
        filters: [
          {
            field: "c.compname",
            op: "contains_compact",
            value: "王者荣耀",
          },
        ],
      },
    });
    if (!decision || decision.kind !== "intent") {
      throw new Error("expected joined dataset intent");
    }
    expect(decision.intent.fields).toContainEqual({ field: "c.compname", alias: "企业名称" });
    expect(decision.intent.fields).toContainEqual({ field: "u.contact_name", alias: "联系人" });
    expect(decision.intent.fields).toContainEqual({ field: "u.mobile", alias: "手机号" });
  });
});

describe("export-agent explicit table inspection", () => {
  beforeEach(() => {
    useDatabaseStore.getState().clearDatabaseClientContext();
    useDatabaseStore.setState({ tableColumns: {}, tables: [] });
    vi.clearAllMocks();
  });

  const personalMysqlSource: RuntimeExportSourceConfig = {
    id: "personal-mysql",
    scope: "personal",
    executionTarget: "local",
    originSourceId: "personal-mysql",
    name: "个人 MySQL",
    db_type: "mysql",
  };

  it("answers table inspection directly even when original request was a company query", async () => {
    vi.mocked(invoke).mockImplementation(async (command, args) => {
      if (command === "db_connect") return null;
      if (command === "db_describe_table") {
        const table = String((args as { table?: string }).table ?? "");
        if (table === "athena_user.company") {
          return [
            { name: "id", data_type: "bigint", nullable: false, primary_key: true },
            { name: "compname", data_type: "varchar", nullable: false, primary_key: false },
            { name: "create_time", data_type: "datetime", nullable: true, primary_key: false },
          ];
        }
        throw new Error(`not found: ${table}`);
      }
      if (command === "db_sample_table") {
        return {
          columns: ["id", "compname", "create_time"],
          rows: [[1, "第一企kkk", "2026-03-24 12:00:00"]],
          affected: 0,
          elapsed_ms: 5,
        };
      }
      return [];
    });

    const decision = await resolveExplicitTableInspectionAnswer({
      userInput: "看一下 athena-user 这个库 company 这个表",
      sources: [personalMysqlSource],
    });

    expect(decision).toEqual({
      kind: "answer",
      answer: expect.stringContaining("已定位到表 athena_user.company"),
    });
    expect(decision && "answer" in decision ? decision.answer : "").toContain("字段：id");
    expect(decision && "answer" in decision ? decision.answer : "").toContain("样本数据：");
    expect(decision && "answer" in decision ? decision.answer : "").toContain("compname=第一企kkk");
  });

  it("maps 看一下企业 to the current schema company table", async () => {
    useDatabaseStore.setState({
      databaseClientContext: {
        connectionId: "personal-mysql",
        connectionName: "个人 MySQL",
        dbType: "mysql",
        schema: "athena_user",
        tableKey: null,
        tableName: null,
      },
      tables: [
        { name: "company", schema: "athena_user", table_type: "BASE TABLE" },
        { name: "company_user", schema: "athena_user", table_type: "BASE TABLE" },
      ],
      tableColumns: {},
    });

    vi.mocked(invoke).mockImplementation(async (command, args) => {
      if (command === "db_connect") return null;
      if (command === "db_describe_table") {
        const table = String((args as { table?: string }).table ?? "");
        if (table === "athena_user.company") {
          return [
            { name: "id", data_type: "bigint", nullable: false, primary_key: true },
            { name: "compname", data_type: "varchar", nullable: false, primary_key: false },
            { name: "update_time", data_type: "datetime", nullable: true, primary_key: false },
          ];
        }
        throw new Error(`not found: ${table}`);
      }
      if (command === "db_sample_table") {
        return {
          columns: ["id", "compname"],
          rows: [[1, "第一企kkk"]],
          affected: 0,
          elapsed_ms: 2,
        };
      }
      return [];
    });

    const decision = await resolveExplicitTableInspectionAnswer({
      userInput: "看一下企业",
      sources: [personalMysqlSource],
    });

    expect(decision).toEqual({
      kind: "answer",
      answer: expect.stringContaining("已定位到表 athena_user.company"),
    });
    expect(decision && "answer" in decision ? decision.answer : "").toContain("compname=第一企kkk");
  });
});
