import { beforeEach, describe, expect, it } from "vitest";

import {
  DIALOG_PRESETS,
  exportCustomPresets,
  importCustomPresets,
  loadCustomPresets,
  normalizeDialogPreset,
  saveCustomPreset,
} from "./dialog-presets";
import { buildDefaultDialogActorConfig } from "./default-dialog-actors";

describe("dialog-presets", () => {
  beforeEach(() => {
    if (typeof localStorage !== "undefined") {
      localStorage.clear();
    }
  });

  it("normalizes builtin presets to executionPolicy-first with compat middleware mirror", () => {
    const reviewer = DIALOG_PRESETS[0]?.participants[0];
    expect(reviewer?.executionPolicy).toEqual({
      accessMode: "read_only",
      approvalMode: "permissive",
    });
    expect(reviewer?.middlewareOverrides).toEqual({
      approvalLevel: "permissive",
    });
  });

  it("upgrades imported legacy presets from middleware approvalLevel", () => {
    const imported = importCustomPresets(JSON.stringify([
      {
        id: "legacy",
        name: "Legacy Preset",
        description: "legacy",
        participants: [
          {
            customName: "Reviewer",
            middlewareOverrides: {
              approvalLevel: "strict",
              disable: ["Clarification"],
            },
          },
        ],
      },
    ]));

    const participant = imported[0]?.participants[0];
    expect(participant?.executionPolicy).toEqual({
      accessMode: "auto",
      approvalMode: "strict",
    });
    expect(participant?.middlewareOverrides).toEqual({
      approvalLevel: "strict",
      disable: ["Clarification"],
    });

    const reloaded = loadCustomPresets();
    expect(reloaded[0]?.participants[0]?.executionPolicy?.approvalMode).toBe("strict");
  });

  it("keeps preset normalization stable when executionPolicy is already present", () => {
    const preset = normalizeDialogPreset({
      id: "custom",
      name: "Custom",
      description: "custom",
      participants: [
        {
          customName: "Builder",
          executionPolicy: { accessMode: "full_access", approvalMode: "normal" },
          middlewareOverrides: { disable: ["Clarification"] },
        },
      ],
    });

    expect(preset.participants[0]).toMatchObject({
      executionPolicy: {
        accessMode: "full_access",
        approvalMode: "normal",
      },
      middlewareOverrides: {
        approvalLevel: "normal",
        disable: ["Clarification"],
      },
    });
  });

  it("stores custom presets without re-expanding approvalLevel mirror", () => {
    saveCustomPreset({
      id: "stored",
      name: "Stored",
      description: "stored",
      participants: [
        {
          customName: "Executor",
          executionPolicy: { accessMode: "auto", approvalMode: "normal" },
        },
      ],
    });

    const raw = localStorage.getItem("mtools-dialog-custom-presets");
    expect(raw).toContain("\"executionPolicy\"");
    expect(raw).not.toContain("\"approvalLevel\"");

    const loaded = loadCustomPresets();
    expect(loaded[0]?.participants[0]?.middlewareOverrides).toEqual({
      approvalLevel: "normal",
    });
  });

  it("exports custom presets in compact executionPolicy-first form", () => {
    saveCustomPreset({
      id: "exported",
      name: "Exported",
      description: "exported",
      participants: [
        {
          customName: "Reviewer",
          executionPolicy: { accessMode: "read_only", approvalMode: "strict" },
          middlewareOverrides: { disable: ["Clarification"] },
        },
      ],
    });

    const exported = exportCustomPresets();
    expect(exported).toContain("\"executionPolicy\"");
    expect(exported).toContain("\"disable\"");
    expect(exported).not.toContain("\"approvalLevel\"");
  });

  it("builds default dialog actors with executionPolicy-derived middleware mirror", () => {
    const external = buildDefaultDialogActorConfig("Lead", {
      mode: "external_im",
      channelType: "feishu",
    });

    expect(external.executionPolicy).toEqual({
      accessMode: "read_only",
      approvalMode: "normal",
    });
    expect(external.middlewareOverrides).toEqual({
      approvalLevel: "normal",
      disable: ["Clarification"],
    });
    expect(external.role.systemPrompt).toContain("send_local_media");
    expect(external.role.systemPrompt).toContain("MEDIA:");
  });

  it("teaches local dialog actors to return local media through MEDIA lines", () => {
    const local = buildDefaultDialogActorConfig("Lead", {
      mode: "local",
      productMode: "dialog",
    });

    expect(local.role.systemPrompt).toContain("桌面端可以直接展示本地图片和导出文件");
    expect(local.role.systemPrompt).toContain("MEDIA:");
    expect(local.role.systemPrompt).toContain("不要声称“当前会话不能直接回发本地图片/文件”");
    expect(local.toolPolicy?.deny).toContain("send_local_media");
  });
});
