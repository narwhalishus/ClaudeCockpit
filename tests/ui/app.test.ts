/**
 * UI component tests for the App shell.
 *
 * Verifies the project selector renders, hash parsing works,
 * and project context flows to child views.
 */
import { describe, it, expect, beforeEach } from "vitest";

import "../../ui/app.ts";
import type { CockpitApp } from "../../ui/app.ts";
import { renderEl, setProps } from "../helpers.ts";

describe("cockpit-app project selector", () => {
  beforeEach(() => {
    document.body.innerHTML = "";
    window.location.hash = "";
  });

  it("renders the project selector in the sidebar", async () => {
    const el = document.createElement("cockpit-app") as CockpitApp;
    await renderEl(el);
    // Set loading false so content renders
    await setProps(el, { loading: false, projects: [] });

    const selector = el.querySelector(".sidebar__project-select");
    expect(selector).not.toBeNull();
  });

  it("shows 'All Projects' as the default option", async () => {
    const el = document.createElement("cockpit-app") as CockpitApp;
    await renderEl(el);
    await setProps(el, { loading: false, projects: [] });

    const select = el.querySelector(
      ".sidebar__project-select"
    ) as HTMLSelectElement;
    expect(select).not.toBeNull();
    const options = Array.from(select.options);
    expect(options[0].value).toBe("");
    expect(options[0].textContent?.trim()).toBe("All Projects");
  });

  it("renders project options from project list", async () => {
    const el = document.createElement("cockpit-app") as CockpitApp;
    await renderEl(el);
    await setProps(el, {
      loading: false,
      projects: [
        { id: "-Users-bryao-Code-Foo", path: "/Users/bryao/Code/Foo", sessionCount: 3, lastActive: null },
        { id: "-Users-bryao-Code-Bar", path: "/Users/bryao/Code/Bar", sessionCount: 1, lastActive: null },
      ],
    });

    const select = el.querySelector(
      ".sidebar__project-select"
    ) as HTMLSelectElement;
    const options = Array.from(select.options);
    // "All Projects" + 2 real projects
    expect(options.length).toBe(3);
    expect(options[1].value).toBe("-Users-bryao-Code-Foo");
    // Should use short path (~ prefix)
    expect(options[1].textContent?.trim()).toBe("~/Code/Foo");
  });
});

describe("cockpit-app hash parsing", () => {
  beforeEach(() => {
    document.body.innerHTML = "";
    window.location.hash = "";
  });

  it("restores tab from hash on connect", async () => {
    window.location.hash = "chat";
    const el = document.createElement("cockpit-app") as CockpitApp;
    await renderEl(el);
    await setProps(el, { loading: false });

    // The topbar title should reflect the active tab
    const title = el.querySelector(".topbar__title");
    expect(title?.textContent?.trim()).toBe("Chat");
  });

  it("restores tab and projectId from hash", async () => {
    window.location.hash = "overview/-Users-bryao-Code-Foo";
    const el = document.createElement("cockpit-app") as CockpitApp;
    await renderEl(el);

    const title = el.querySelector(".topbar__title");
    expect(title?.textContent?.trim()).toBe("Overview");

    // Verify the component parsed the projectId from the hash.
    // We check state directly since <select>.value binding in jsdom
    // doesn't sync until options exist in a subsequent render pass.
    expect((el as unknown as { selectedProjectId: string }).selectedProjectId).toBe(
      "-Users-bryao-Code-Foo"
    );
  });
});
