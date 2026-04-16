import { LitElement, html } from "lit";
import { customElement, state } from "lit/decorators.js";
import { MODEL_OPTIONS } from "../constants.ts";

const STORAGE_KEY = "cockpit-settings";

const THEME_OPTIONS = [
  { value: "dark", label: "Dark" },
  { value: "light", label: "Light" },
];

interface SettingsData {
  defaultModel: string;
  theme?: string;
}

function loadSettings(): SettingsData {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw) return JSON.parse(raw);
  } catch { /* ignore */ }
  return { defaultModel: "" };
}

function saveSettings(settings: SettingsData) {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(settings));
}

@customElement("cockpit-settings")
export class CockpitSettings extends LitElement {
  protected override createRenderRoot() {
    return this;
  }

  @state() private defaultModel = "";
  @state() private theme = "dark";

  override connectedCallback() {
    super.connectedCallback();
    const settings = loadSettings();
    this.defaultModel = settings.defaultModel;
    this.theme = settings.theme || "dark";
  }

  private _onModelChange(e: Event) {
    this.defaultModel = (e.target as HTMLSelectElement).value;
    saveSettings({ defaultModel: this.defaultModel, theme: this.theme });
  }

  private _onThemeChange(value: string) {
    this.theme = value;
    document.documentElement.setAttribute("data-theme", value);
    saveSettings({ defaultModel: this.defaultModel, theme: this.theme });
  }

  override render() {
    return html`
      <div class="settings">
        <div class="settings__section">
          <div class="settings__section-title">Appearance</div>
          <div class="settings__row">
            <label class="settings__label">Theme</label>
            <div class="settings__control">
              <div class="settings__button-group">
                ${THEME_OPTIONS.map(
                  (opt) => html`
                    <button
                      class="settings__button-group-btn ${opt.value === this.theme ? "settings__button-group-btn--active" : ""}"
                      @click=${() => this._onThemeChange(opt.value)}
                    >${opt.label}</button>
                  `
                )}
              </div>
              <div class="settings__hint">Switch between dark and light color schemes.</div>
            </div>
          </div>
        </div>

        <div class="settings__section">
          <div class="settings__section-title">Chat Defaults</div>
          <div class="settings__row">
            <label class="settings__label" for="default-model">Starting Model</label>
            <div class="settings__control">
              <select
                id="default-model"
                class="settings__select"
                @change=${this._onModelChange}
              >
                <option value="" ?selected=${!this.defaultModel}>Claude Code default</option>
                ${MODEL_OPTIONS.map(
                  (opt) => html`
                    <option value=${opt.value} ?selected=${opt.value === this.defaultModel}>${opt.label}</option>
                  `
                )}
              </select>
              <div class="settings__hint">Model used for new chat sessions when no per-session override is set.</div>
            </div>
          </div>
        </div>
      </div>
    `;
  }
}
