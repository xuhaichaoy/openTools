import React from "react";
import { act } from "react";
import { afterEach, describe, expect, it } from "vitest";
import { createRoot, type Root } from "react-dom/client";

import { MessageBubble } from "./MessageBubble";
import type { DialogMessage } from "@/core/agent/actor/types";

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

describe("MessageBubble", () => {
  let container: HTMLDivElement | null = null;
  let root: Root | null = null;

  afterEach(() => {
    if (root && container) {
      act(() => {
        root?.unmount();
      });
    }
    container?.remove();
    container = null;
    root = null;
  });

  it("keeps user bubble on the right while left-aligning its content", () => {
    const message: DialogMessage = {
      id: "msg-user-1",
      from: "user",
      content: "第一行\n第二行",
      timestamp: Date.UTC(2026, 2, 26, 4, 47, 11),
      priority: "normal",
    };

    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);

    act(() => {
      root?.render(
        <MessageBubble
          message={message}
          actorIndex={0}
          actorName="你"
          isUser
        />,
      );
    });

    const prose = container?.querySelector(".prose");
    expect(prose).not.toBeNull();
    expect(prose?.className).toContain("text-left");
    expect(prose?.className).not.toContain("[&_p]:text-right");

    const bubble = prose?.parentElement;
    expect(bubble?.className).toContain("text-left");
    expect(container?.textContent).toContain("第一行");
    expect(container?.textContent).toContain("第二行");
  });
});
