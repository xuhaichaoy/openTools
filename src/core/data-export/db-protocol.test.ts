import { describe, expect, it } from "vitest";

import { parseDatabaseProtocolDirective } from "./db-protocol";

describe("db-protocol", () => {
  it("parses namespace existence directives", () => {
    expect(parseDatabaseProtocolDirective(
      '{"version":"dbproto/v1","action":"namespace_exists","sourceId":"personal-mysql","namespace":"athena_user"}',
    )).toEqual({
      version: "dbproto/v1",
      action: "namespace_exists",
      sourceId: "personal-mysql",
      namespace: "athena_user",
    });
  });

  it("parses fenced sample-table directives", () => {
    expect(parseDatabaseProtocolDirective(
      '```json\n{"version":"dbproto/v1","action":"sample_table","table":"athena_user.company","limit":20}\n```',
    )).toEqual({
      version: "dbproto/v1",
      action: "sample_table",
      table: "athena_user.company",
      limit: 10,
    });
  });

  it("returns null for invalid protocol payloads", () => {
    expect(parseDatabaseProtocolDirective('{"action":"list_tables"}')).toBeNull();
    expect(parseDatabaseProtocolDirective('{"version":"dbproto/v2","action":"list_tables"}')).toBeNull();
    expect(parseDatabaseProtocolDirective('{"version":"dbproto/v1","action":"describe_table"}')).toBeNull();
  });

  it("parses search-table directives", () => {
    expect(parseDatabaseProtocolDirective(
      '{"version":"dbproto/v1","action":"search_tables","sourceId":"personal-mysql","namespace":"athena_user","keyword":"订单","limit":6}',
    )).toEqual({
      version: "dbproto/v1",
      action: "search_tables",
      sourceId: "personal-mysql",
      namespace: "athena_user",
      keyword: "订单",
      limit: 6,
    });
  });

  it("parses dataset directives", () => {
    expect(parseDatabaseProtocolDirective(
      '{"version":"dbproto/v1","action":"describe_dataset","datasetId":"team:team-1:dataset:orders"}',
    )).toEqual({
      version: "dbproto/v1",
      action: "describe_dataset",
      datasetId: "team:team-1:dataset:orders",
    });
  });
});
