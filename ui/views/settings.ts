import { LitElement, html } from "lit";
import { customElement, state } from "lit/decorators.js";

const MODEL_OPTIONS = [
  { value: "claude-opus-4-6", label: "Opus 4.6" },
  { value: "claude-sonnet-4-6", label: "Sonnet 4.6" },
  { value: "claude-haiku-4-5", label: "Haiku 4.5" },
];

const STORAGE_KEY = "cockpit-settings";

interface SettingsData {
  defaultModel: string;
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

  override connectedCallback() {
    super.connectedCallback();
    this.defaultModel = loadSettings().defaultModel;
  }

  private _onModelChange(e: Event) {
    this.defaultModel = (e.target as HTMLSelectElement).value;
    saveSettings({ defaultModel: this.defaultModel });
  }

  override render() {
    return html`
      <div class="settings">
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
