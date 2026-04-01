import { LitElement, html } from "lit";
import { customElement, state } from "lit/decorators.js";
import type {
  CockpitTab,
  SessionSummary,
  OverviewStats,
  Project,
} from "./types.ts";
import { GatewayBrowserClient } from "./gateway.ts";
import "./views/overview.ts";
import "./views/sessions.ts";
import "./views/projects.ts";
import "./views/chat.ts";
import type { CockpitChat } from "./views/chat.ts";

// SVG icon helpers
const icons = {
  overview: html`<svg viewBox="0 0 24 24"><rect x="3" y="3" width="7" height="7" rx="1"/><rect x="14" y="3" width="7" height="7" rx="1"/><rect x="3" y="14" width="7" height="7" rx="1"/><rect x="14" y="14" width="7" height="7" rx="1"/></svg>`,
  sessions: html`<svg viewBox="0 0 24 24"><path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/></svg>`,
  projects: html`<svg viewBox="0 0 24 24"><path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z"/></svg>`,
  usage: html`<svg viewBox="0 0 24 24"><path d="M18 20V10"/><path d="M12 20V4"/><path d="M6 20v-6"/></svg>`,
  chat: html`<svg viewBox="0 0 24 24"><path d="M12 20h9"/><path d="M16.376 3.622a1 1 0 0 1 3.002 3.002L7.368 18.635a2 2 0 0 1-.855.506l-2.872.838a.5.5 0 0 1-.62-.62l.838-2.872a2 2 0 0 1 .506-.854z"/></svg>`,
};

type NavItem = { id: CockpitTab; label: string; icon: typeof icons.overview };

const NAV_ITEMS: NavItem[] = [
  { id: "overview", label: "Overview", icon: icons.overview },
  { id: "sessions", label: "Sessions", icon: icons.sessions },
  { id: "projects", label: "Projects", icon: icons.projects },
  { id: "chat", label: "Chat", icon: icons.chat },
  { id: "usage", label: "Usage", icon: icons.usage },
];

@customElement("cockpit-app")
export class CockpitApp extends LitElement {
  protected override createRenderRoot() {
    return this;
  }

  @state() private tab: CockpitTab = "overview";
  @state() private selectedProjectId = "";
  @state() private connected = false;
  @state() private loading = true;
  @state() private overviewStats: OverviewStats | null = null;
  @state() private sessions: SessionSummary[] = [];
  @state() private projects: Project[] = [];

  /** Session ID to open when switching to chat tab */
  private _pendingSessionId: string | null = null;

  private gateway = new GatewayBrowserClient();

  override connectedCallback() {
    super.connectedCallback();
    const { tab, projectId } = this._parseHash();
    if (tab) this.tab = tab;
    if (projectId) this.selectedProjectId = projectId;
    window.addEventListener("hashchange", this._onHashChange);

    // Connect WebSocket
    this.gateway.onConnectionChange = (connected) => {
      this.connected = connected;
      if (connected) {
        this._fetchViaWs();
      }
    };
    this.gateway.connect();

    // Also fetch via HTTP as fallback (in case WS takes a moment)
    this._fetchViaHttp();
  }

  override disconnectedCallback() {
    super.disconnectedCallback();
    window.removeEventListener("hashchange", this._onHashChange);
    this.gateway.disconnect();
  }

  private _onHashChange = () => {
    const { tab, projectId } = this._parseHash();
    if (tab) this.tab = tab;
    if (projectId !== this.selectedProjectId) {
      this.selectedProjectId = projectId;
      this._refetchData();
    }
  };

  /** Parse "#tab/projectId" from the URL hash */
  private _parseHash(): { tab: CockpitTab | null; projectId: string } {
    const raw = window.location.hash.slice(1);
    const [tabPart, ...rest] = raw.split("/");
    const projectId = rest.join("/");
    const tab = NAV_ITEMS.some((n) => n.id === tabPart)
      ? (tabPart as CockpitTab)
      : null;
    return { tab, projectId: projectId ?? "" };
  }

  /** Write "#tab" or "#tab/projectId" to the URL hash */
  private _syncHash() {
    const hash = this.selectedProjectId
      ? `${this.tab}/${this.selectedProjectId}`
      : this.tab;
    window.location.hash = hash;
  }

  /** Fetch data via WebSocket (primary path) */
  private async _fetchViaWs() {
    try {
      const projectParam = this.selectedProjectId || undefined;
      const [overview, sessionsData, projectsData] = await Promise.all([
        this.gateway.request("overview.get", { project: projectParam }),
        this.gateway.request("sessions.list", { project: projectParam }),
        this.gateway.request("projects.list"),
      ]);
      this.overviewStats = overview as OverviewStats;
      this.sessions = (sessionsData as { sessions: SessionSummary[] }).sessions;
      this.projects = (projectsData as { projects: Project[] }).projects;
      this.loading = false;
    } catch (err) {
      console.warn("WS fetch failed, falling back to HTTP:", err);
    }
  }

  /** Fetch data via HTTP (fallback) */
  private async _fetchViaHttp() {
    this.loading = true;
    try {
      const projectQuery = this.selectedProjectId
        ? `?project=${encodeURIComponent(this.selectedProjectId)}`
        : "";
      const [overviewRes, sessionsRes, projectsRes] = await Promise.all([
        fetch(`/api/overview${projectQuery}`),
        fetch(`/api/sessions${projectQuery}`),
        fetch("/api/projects"),
      ]);
      if (overviewRes.ok) this.overviewStats = await overviewRes.json();
      if (sessionsRes.ok) {
        const data = await sessionsRes.json();
        this.sessions = data.sessions;
      }
      if (projectsRes.ok) {
        const data = await projectsRes.json();
        this.projects = data.projects;
      }
      this.connected = true;
    } catch (err) {
      console.error("HTTP fetch failed:", err);
      this.connected = false;
    } finally {
      this.loading = false;
    }
  }

  private _navigate(tab: CockpitTab) {
    this.tab = tab;
    this._syncHash();
  }

  private _openSessionInChat(sessionId: string) {
    this._pendingSessionId = sessionId;
    this._navigate("chat");
  }

  private _shortPath(path: string): string {
    return path.replace(/^\/Users\/[^/]+/, "~");
  }

  private _onProjectChange(e: Event) {
    this.selectedProjectId = (e.target as HTMLSelectElement).value;
    this._syncHash();
    this._refetchData();
  }

  /** Called when a project row is clicked in the Projects view */
  private _selectProjectFromView(projectId: string) {
    this.selectedProjectId = projectId;
    this._navigate("overview");
    this._refetchData();
  }

  /** Re-fetch overview + sessions for current project selection */
  private _refetchData() {
    if (this.gateway.connected) {
      this._fetchViaWs();
    } else {
      this._fetchViaHttp();
    }
  }

  override updated() {
    if (this.tab === "chat") {
      const chatEl = this.querySelector("cockpit-chat") as CockpitChat | null;
      if (chatEl && this.gateway) {
        chatEl.setGateway(this.gateway);
        // If we have a pending session to open, load it
        if (this._pendingSessionId) {
          chatEl.openSession(this._pendingSessionId);
          this._pendingSessionId = null;
        }
      }
    }
  }

  override render() {
    return html`
      <div class="shell">
        <nav class="shell-nav">
          <div class="sidebar">
            <div class="sidebar__header">
              <img class="sidebar__logo" src="/logo.svg" alt="Claude Code" />
            </div>
            <div class="sidebar__project-selector">
              <select
                class="sidebar__project-select"
                .value=${this.selectedProjectId}
                @change=${this._onProjectChange}
              >
                <option value="">All Projects</option>
                ${this.projects.map(
                  (p) => html`
                    <option value=${p.id}>${this._shortPath(p.path)}</option>
                  `
                )}
              </select>
            </div>
            <div class="sidebar-nav">
              <div class="nav-section">
                <div class="nav-section__label">Cockpit</div>
                ${NAV_ITEMS.map(
                  (item) => html`
                    <button
                      class="nav-item ${this.tab === item.id ? "nav-item--active" : ""}"
                      @click=${() => this._navigate(item.id)}
                    >
                      <span class="nav-item__icon">${item.icon}</span>
                      <span>${item.label}</span>
                    </button>
                  `
                )}
              </div>
            </div>
            <div class="sidebar__footer">
              <div class="sidebar-version">
                <span class="sidebar-version__label">Gateway</span>
                <span class="sidebar-version__text">
                  <span class="statusDot ${this.connected ? "statusDot--ok" : "statusDot--danger"}" style="display:inline-block;vertical-align:middle;margin-right:6px"></span>
                  ${this.connected ? "Connected" : "Offline"}
                </span>
              </div>
            </div>
          </div>
        </nav>

        <header class="topbar">
          <span class="topbar__title">
            ${NAV_ITEMS.find((n) => n.id === this.tab)?.label ?? "Cockpit"}
          </span>
          <div class="topbar__status">
            <span class="pill ${this.connected ? "pill--ok" : "pill--danger"}">
              <span class="statusDot ${this.connected ? "statusDot--ok" : "statusDot--danger"}"></span>
              ${this.connected ? "Online" : "Offline"}
            </span>
          </div>
        </header>

        <main class="content">
          ${this._renderTab()}
        </main>
      </div>
    `;
  }

  private _renderTab() {
    if (this.loading) {
      return html`<div class="loading-spinner"></div>`;
    }

    switch (this.tab) {
      case "overview":
        return html`
          <cockpit-overview
            .stats=${this.overviewStats}
            .projectId=${this.selectedProjectId}
            .onNavigate=${(tab: CockpitTab) => this._navigate(tab)}
          ></cockpit-overview>
        `;
      case "sessions":
        return html`
          <cockpit-sessions
            .sessions=${this.sessions}
            .projectId=${this.selectedProjectId}
            .onOpenSession=${(id: string) => this._openSessionInChat(id)}
          ></cockpit-sessions>
        `;
      case "projects":
        return html`
          <cockpit-projects
            .projects=${this.projects}
            .onSelectProject=${(projectId: string) => this._selectProjectFromView(projectId)}
          ></cockpit-projects>
        `;
      case "chat":
        return html`<cockpit-chat .projectId=${this.selectedProjectId}></cockpit-chat>`;
      case "usage":
        return html`
          <cockpit-overview
            .stats=${this.overviewStats}
            .projectId=${this.selectedProjectId}
            .onNavigate=${(tab: CockpitTab) => this._navigate(tab)}
          ></cockpit-overview>
        `;
      default:
        return html`<p>Unknown tab</p>`;
    }
  }
}
