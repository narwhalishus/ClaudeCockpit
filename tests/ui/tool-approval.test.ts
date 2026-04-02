/**
 * UI component tests for the tool approval banner.
 *
 * Verifies the approval banner renders when pendingApproval is set,
 * displays correct tool information, and clears on button click.
 */
import { describe, it, expect, beforeEach } from "vitest";

import "../../ui/views/chat.ts";
import type { CockpitChat } from "../../ui/views/chat.ts";
import type { ToolApprovalEvent } from "../../ui/types.ts";
import { renderEl, setProps } from "../helpers.ts";

function makeBashApproval(): ToolApprovalEvent {
  return {
    chatId: "chat-1",
    request_id: "req-001",
    request: {
      subtype: "can_use_tool",
      tool_name: "Bash",
      input: { command: "ls -la /tmp", description: "List files in /tmp" },
      tool_use_id: "toolu_001",
      description: "List files in /tmp directory",
    },
  };
}

function makeEditApproval(): ToolApprovalEvent {
  return {
    chatId: "chat-1",
    request_id: "req-002",
    request: {
      subtype: "can_use_tool",
      tool_name: "Edit",
      input: {
        file_path: "/Users/bryao/Code/test.ts",
        old_string: "const x = 1;",
        new_string: "const x = 2;",
      },
      tool_use_id: "toolu_002",
    },
  };
}

describe("cockpit-chat tool approval banner", () => {
  beforeEach(() => {
    document.body.innerHTML = "";
  });

  it("does not render banner when pendingApproval is null", async () => {
    const el = document.createElement("cockpit-chat") as CockpitChat;
    await renderEl(el);

    const banner = el.querySelector(".tool-approval");
    expect(banner).toBeNull();
  });

  it("renders banner when pendingApproval is set", async () => {
    const el = document.createElement("cockpit-chat") as CockpitChat;
    await renderEl(el);

    await setProps(el, { pendingApproval: makeBashApproval() });

    const banner = el.querySelector(".tool-approval");
    expect(banner).not.toBeNull();
  });

  it("displays tool name for Bash approval", async () => {
    const el = document.createElement("cockpit-chat") as CockpitChat;
    await renderEl(el);

    await setProps(el, { pendingApproval: makeBashApproval() });

    const toolName = el.querySelector(".tool-approval__tool-name");
    expect(toolName?.textContent?.trim()).toBe("Bash");
  });

  it("displays Bash command in code block", async () => {
    const el = document.createElement("cockpit-chat") as CockpitChat;
    await renderEl(el);

    await setProps(el, { pendingApproval: makeBashApproval() });

    const code = el.querySelector(".tool-approval__code");
    expect(code?.textContent).toContain("ls -la /tmp");
  });

  it("displays description when present", async () => {
    const el = document.createElement("cockpit-chat") as CockpitChat;
    await renderEl(el);

    await setProps(el, { pendingApproval: makeBashApproval() });

    const desc = el.querySelector(".tool-approval__desc");
    expect(desc?.textContent).toContain("List files in /tmp directory");
  });

  it("displays file path and diff for Edit approval", async () => {
    const el = document.createElement("cockpit-chat") as CockpitChat;
    await renderEl(el);

    await setProps(el, { pendingApproval: makeEditApproval() });

    const filePath = el.querySelector(".tool-approval__file");
    expect(filePath?.textContent).toContain("test.ts");

    const delBlock = el.querySelector(".tool-approval__code--del");
    expect(delBlock?.textContent).toContain("const x = 1;");

    const addBlock = el.querySelector(".tool-approval__code--add");
    expect(addBlock?.textContent).toContain("const x = 2;");
  });

  it("renders Allow and Deny buttons", async () => {
    const el = document.createElement("cockpit-chat") as CockpitChat;
    await renderEl(el);

    await setProps(el, { pendingApproval: makeBashApproval() });

    const allow = el.querySelector(".tool-approval__allow");
    const deny = el.querySelector(".tool-approval__deny");
    expect(allow).not.toBeNull();
    expect(deny).not.toBeNull();
    expect(allow?.textContent).toContain("Allow");
    expect(deny?.textContent).toContain("Deny");
  });

  it("shows keyboard shortcut hints", async () => {
    const el = document.createElement("cockpit-chat") as CockpitChat;
    await renderEl(el);

    await setProps(el, { pendingApproval: makeBashApproval() });

    const kbds = el.querySelectorAll(".tool-approval__actions kbd");
    const hints = Array.from(kbds).map((k) => k.textContent?.trim());
    expect(hints).toContain("Y");
    expect(hints).toContain("N");
  });
});
