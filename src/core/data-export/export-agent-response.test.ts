import { describe, expect, it } from "vitest";
import {
  isExportMetadataQuestion,
  parseExportAgentResponse,
} from "./export-agent-response";

describe("export-agent-response", () => {
  it("parses explicit answer json", () => {
    expect(
      parseExportAgentResponse('{"kind":"answer","answer":"当前可读取的库有 crm、oms"}'),
    ).toEqual({
      kind: "answer",
      answer: "当前可读取的库有 crm、oms",
    });
  });

  it("falls back to plain answer for metadata questions", () => {
    expect(
      parseExportAgentResponse(
        "当前可读取的 database 有：crm、oms、analytics。",
        { userInput: "目前都能读取哪些库" },
      ),
    ).toEqual({
      kind: "answer",
      answer: "当前可读取的 database 有：crm、oms、analytics。",
    });
  });

  it("parses fenced json payload", () => {
    expect(
      parseExportAgentResponse(
        '```json\n{"kind":"answer","answer":"可用数据源 1 个"}\n```',
        { userInput: "目前有哪些数据源" },
      ),
    ).toEqual({
      kind: "answer",
      answer: "可用数据源 1 个",
    });
  });

  it("parses join intent payload with aliased fields", () => {
    expect(
      parseExportAgentResponse(
        JSON.stringify({
          kind: "intent",
          summary: "从企业表联推广用户表导出企业名称和手机号",
          intent: {
            sourceId: "personal-mysql",
            entityName: "company",
            entityType: "table",
            schema: "athena_user",
            baseAlias: "c",
            fields: [
              { field: "c.compname", alias: "company_name" },
              { field: "u.mobile", alias: "user_mobile" },
            ],
            joins: [
              {
                entityName: "promote_user",
                schema: "athena_basis",
                alias: "u",
                joinType: "left",
                on: [
                  { left: "c.id", op: "eq", right: "u.company_id" },
                ],
              },
            ],
            filters: [
              { field: "c.compname", op: "contains", value: "王者荣耀" },
            ],
            sort: [
              { field: "u.create_time", direction: "desc" },
            ],
            limit: 500,
            outputFormat: "csv",
          },
        }),
      ),
    ).toEqual({
      kind: "intent",
      summary: "从企业表联推广用户表导出企业名称和手机号",
      intent: {
        sourceId: "personal-mysql",
        entityName: "company",
        entityType: "table",
        schema: "athena_user",
        baseAlias: "c",
        fields: [
          { field: "c.compname", alias: "company_name" },
          { field: "u.mobile", alias: "user_mobile" },
        ],
        joins: [
          {
            entityName: "promote_user",
            schema: "athena_basis",
            alias: "u",
            joinType: "left",
            on: [
              { left: "c.id", op: "eq", right: "u.company_id" },
            ],
          },
        ],
        filters: [
          { field: "c.compname", op: "contains", value: "王者荣耀" },
        ],
        sort: [
          { field: "u.create_time", direction: "desc" },
        ],
        limit: 500,
        outputFormat: "csv",
      },
    });
  });

  it("does not treat arbitrary prose as answer for export requests", () => {
    expect(() =>
      parseExportAgentResponse(
        "我建议你先确认一下要导出哪些字段。",
        { userInput: "帮我从数据库导出昨天的订单" },
      ),
    ).toThrow("导出 Agent 返回不是有效 JSON");
  });

  it("recognizes metadata questions", () => {
    expect(isExportMetadataQuestion("目前都能读取哪些库")).toBe(true);
    expect(isExportMetadataQuestion("有哪些 schema 可以查")).toBe(true);
    expect(isExportMetadataQuestion("里面是否有 athena_user 的库")).toBe(true);
    expect(isExportMetadataQuestion("帮我从数据库导出昨天订单")).toBe(false);
  });

  it("falls back to clarify when the agent returns a plain question", () => {
    expect(
      parseExportAgentResponse(
        "在数据库中找到了多个同名候选表，请问你要查企业基础信息，还是企业联系人信息？",
        { userInput: "帮我查询王者荣耀企业信息" },
      ),
    ).toEqual({
      kind: "clarify",
      question: "在数据库中找到了多个同名候选表，请问你要查企业基础信息，还是企业联系人信息？",
    });
  });

  it("rewrites schema-leaking clarify questions into business-facing wording", () => {
    expect(
      parseExportAgentResponse(
        "在数据库中搜索'公司表'，没有找到直接包含'公司'字样的表。找到以下可能相关的表（包含company_id字段）：athena_basis.promote_user、athena_basis.promote_user_log、athena_basis.promote_wechat_user。请问您要找的是在promote_user表中按公司名称查询，还是有其他具体表名或字段名？",
        { userInput: "帮我查询王者荣耀公司信息" },
      ),
    ).toEqual({
      kind: "clarify",
      question: "我还不能稳定确认你要的是哪类企业数据。请直接告诉我你更想导出哪一种业务信息：企业基础信息、联系人/电话、推广归属，还是订单/交易相关信息。",
    });
  });

  it("falls back to reject when the agent returns an iteration-exhausted summary", () => {
    expect(
      parseExportAgentResponse(
        "已达到最大执行步数（8 步）。\n执行诊断：\n- 工具执行次数：8",
        { userInput: "帮我从数据库导出王者荣耀企业详细信息" },
      ),
    ).toEqual({
      kind: "reject",
      reason: "这次导出在自动探查数据结构时没有稳定收敛。请把需求再说具体一点，例如“帮我查询某企业的联系人和电话”，或者先问“目前有哪些数据源/库可以查询”。",
    });
  });

  it("rewrites metadata-tool-unavailable errors into business-facing guidance", () => {
    expect(
      parseExportAgentResponse(
        "当前环境未提供导出专线所需的元数据工具，无法先确认数据源、schema、候选表、字段和样本数据。",
        { userInput: "查询 第一企kkk 这个公司的信息" },
      ),
    ).toEqual({
      kind: "reject",
      reason: "这次查数没有稳定定位到业务口径。请直接说你想查哪类企业数据，例如“查询某公司的基础信息”“查询某公司的联系人和电话”“查询某公司的订单信息”。",
    });
  });
});
