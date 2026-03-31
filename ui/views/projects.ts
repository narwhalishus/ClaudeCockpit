import { LitElement, html } from "lit";
import { customElement, property } from "lit/decorators.js";
import type { Project } from "../types.ts";

function formatRelativeTime(iso: string | null): string {
  if (!iso) return "Never";
  const diff = Date.now() - new Date(iso).getTime();
  const mins = Math.floor(diff / 60_000);
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  return `${days}d ago`;
}

@customElement("cockpit-projects")
export class CockpitProjects extends LitElement {
  protected override createRenderRoot() {
    return this;
  }

  @property({ type: Array }) projects: Project[] = [];

  override render() {
    return html`
      <div class="content-header">
        <div>
          <h1 class="page-title">Projects</h1>
          <p class="page-sub">${this.projects.length} projects with Claude Code sessions</p>
        </div>
      </div>

      ${this.projects.length === 0
        ? html`
            <div class="empty-state">
              <div class="empty-state__icon">&#128193;</div>
              <div class="empty-state__text">No projects found</div>
              <div class="empty-state__hint">Claude Code session data will appear here</div>
            </div>
          `
        : html`
            <table class="data-table">
              <thead>
                <tr>
                  <th>Project Path</th>
                  <th>Sessions</th>
                  <th>Last Active</th>
                </tr>
              </thead>
              <tbody>
                ${this.projects.map(
                  (p) => html`
                    <tr>
                      <td class="mono">${this._shortPath(p.path)}</td>
                      <td>${p.sessionCount}</td>
                      <td class="muted">${formatRelativeTime(p.lastActive)}</td>
                    </tr>
                  `
                )}
              </tbody>
            </table>
          `}
    `;
  }

  private _shortPath(path: string): string {
    return path.replace(/^\/Users\/[^/]+/, "~");
  }
}
