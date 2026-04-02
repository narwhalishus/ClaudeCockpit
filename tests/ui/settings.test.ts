/**
 * UI component tests for the Settings view.
 *
 * Verifies model selection dropdown renders correctly and
 * persists the selected model to localStorage.
 */
import { describe, it, expect, beforeEach } from "vitest";

import "../../ui/views/settings.ts";
import type { CockpitSettings } from "../../ui/views/settings.ts";
import { renderEl } from "../helpers.ts";

describe("cockpit-settings", () => {
  beforeEach(() => {
    document.body.innerHTML = "";
    localStorage.clear();
  });

  it("renders a model selection dropdown", async () => {
    const el = document.createElement("cockpit-settings") as CockpitSettings;
    await renderEl(el);

    const select = el.querySelector("select") as HTMLSelectElement;
    expect(select).not.toBeNull();

    const options = Array.from(select.options).map((o) => o.value);
    expect(options).toContain("");
    expect(options).toContain("claude-opus-4-6");
    expect(options).toContain("claude-sonnet-4-6");
    expect(options).toContain("claude-haiku-4-5");
  });

  it("defaults to empty (Claude Code default) when no localStorage", async () => {
    const el = document.createElement("cockpit-settings") as CockpitSettings;
    await renderEl(el);

    const select = el.querySelector("select") as HTMLSelectElement;
    expect(select.value).toBe("");
  });

  it("restores saved model from localStorage", async () => {
    localStorage.setItem("cockpit-settings", JSON.stringify({ defaultModel: "claude-sonnet-4-6" }));

    const el = document.createElement("cockpit-settings") as CockpitSettings;
    await renderEl(el);

    const select = el.querySelector("select") as HTMLSelectElement;
    expect(select.value).toBe("claude-sonnet-4-6");
  });

  it("persists model selection to localStorage on change", async () => {
    const el = document.createElement("cockpit-settings") as CockpitSettings;
    await renderEl(el);

    const select = el.querySelector("select") as HTMLSelectElement;
    select.value = "claude-opus-4-6";
    select.dispatchEvent(new Event("change"));

    await (el as unknown as { updateComplete: Promise<boolean> }).updateComplete;

    const stored = JSON.parse(localStorage.getItem("cockpit-settings")!);
    expect(stored.defaultModel).toBe("claude-opus-4-6");
  });

  it("renders the section title", async () => {
    const el = document.createElement("cockpit-settings") as CockpitSettings;
    await renderEl(el);

    const title = el.querySelector(".settings__section-title");
    expect(title?.textContent).toBe("Chat Defaults");
  });
});
