/**
 * Settings panel: Topbar button -> PopupModal with a Spicetify.React form.
 * Every Spicetify API is optional; missing APIs make this a silent no-op.
 */
import pkg from "../../package.json";
import {
  SOURCE_IDS,
  clearWtgCache,
  currentLang,
  getManualGenre,
  loadSettings,
  panelText,
  removeManualGenre,
  resetSettings,
  saveSettings,
  setManualGenre,
  validSourceOrder,
  type KV,
  type LangSetting,
  type PanelKey,
  type SourceId,
} from "./store";

export const PACKAGE_VERSION: string = pkg.version;

export type PanelHooks = {
  storage: () => KV | undefined;
  /** Mark the cache stale and search the current track again. */
  refreshNow: () => void;
  /** Called after any change that should re-render the genre row. */
  changed: () => void;
};

const S = () => (globalThis as any).Spicetify as any;

function currentUri(): string {
  try {
    return String(S()?.Player?.data?.item?.uri ?? "");
  } catch {
    return "";
  }
}

export function buildPanel(hooks: PanelHooks): unknown {
  const R = S().React;
  const h = R.createElement as (...a: unknown[]) => unknown;
  const Panel = () => {
    const [, bump] = R.useState(0);
    const rerender = () => bump((n: number) => n + 1);
    const [armed, setArmed] = R.useState("");
    const [manual, setManual] = R.useState("");
    const storage = hooks.storage();
    const settings = loadSettings(storage);
    const lang = currentLang(storage);
    const t = (k: PanelKey) => panelText(lang, k);
    const uri = currentUri();
    const saved = getManualGenre(storage, uri);

    const update = (patch: Partial<typeof settings>) => {
      saveSettings(storage, { ...settings, ...patch });
      hooks.changed();
      rerender();
    };
    const confirmThen = (id: string, run: () => void) => () => {
      if (armed !== id) {
        setArmed(id);
        setTimeout(() => setArmed((a: string) => (a === id ? "" : a)), 4000);
        return;
      }
      setArmed("");
      run();
    };
    const css = {
      color: "var(--spice-text)",
      background: "var(--spice-main)",
      border: "1px solid var(--spice-button-disabled)",
      borderRadius: 4,
      padding: "4px 8px",
    };
    const btn = (label: string, onClick: () => void, extra = {}) =>
      h(
        "button",
        { type: "button", onClick, style: { ...css, ...extra } },
        label,
      );
    const row = (...kids: unknown[]) =>
      h(
        "div",
        {
          style: {
            display: "flex",
            gap: 8,
            alignItems: "center",
            margin: "8px 0",
          },
        },
        ...kids,
      );
    const sourceSelects = SOURCE_IDS.map((_, i) =>
      h(
        "select",
        {
          key: i,
          "aria-label": `${t("position")} ${i + 1}`,
          value: settings.sourceOrder[i],
          style: css,
          onChange: (e: any) => {
            // swap with the slot that already holds the chosen source -> stays a permutation
            const next = [...settings.sourceOrder] as SourceId[];
            const chosen = e.target.value as SourceId;
            const j = next.indexOf(chosen);
            if (j >= 0) next[j] = next[i];
            next[i] = chosen;
            update({
              sourceOrder: validSourceOrder(next) ?? settings.sourceOrder,
            });
          },
        },
        SOURCE_IDS.map((id) =>
          h("option", { key: id, value: id }, t(`source_${id}` as PanelKey)),
        ),
      ),
    );

    return h(
      "div",
      { style: { color: "var(--spice-text)", minWidth: 320 } },
      row(h("strong", null, `${t("version")}: ${PACKAGE_VERSION}`)),
      h("div", null, t("sourceOrder")),
      row(...sourceSelects),
      row(
        h("label", null, t("language")),
        h(
          "select",
          {
            "aria-label": t("language"),
            value: settings.lang,
            style: css,
            onChange: (e: any) =>
              update({ lang: e.target.value as LangSetting }),
          },
          h("option", { value: "auto" }, t("langAuto")),
          h("option", { value: "tr" }, "Türkçe"),
          h("option", { value: "en" }, "English"),
        ),
      ),
      h("div", null, t("manualTitle")),
      row(
        h("input", {
          type: "text",
          style: { ...css, flex: 1 },
          placeholder: uri ? t("manualPlaceholder") : t("noTrack"),
          disabled: !uri,
          value: manual !== "" ? manual : (saved ?? ""),
          onChange: (e: any) => setManual(e.target.value),
        }),
        btn(t("save"), () => {
          const v = manual !== "" ? manual : (saved ?? "");
          if (setManualGenre(storage, uri, v)) {
            setManual("");
            hooks.changed();
            rerender();
          }
        }),
        btn(t("remove"), () => {
          removeManualGenre(storage, uri);
          setManual("");
          hooks.changed();
          rerender();
        }),
      ),
      row(
        btn(t("refreshNow"), () => hooks.refreshNow()),
        btn(
          armed === "cache" ? t("confirm") : t("clearCache"),
          confirmThen("cache", () => {
            clearWtgCache(storage);
            hooks.changed();
          }),
        ),
        btn(
          armed === "reset" ? t("confirm") : t("resetDefaults"),
          confirmThen("reset", () => {
            resetSettings(storage);
            hooks.changed();
            rerender();
          }),
        ),
      ),
    );
  };
  return h(Panel, null);
}

export function openPanel(hooks: PanelHooks): void {
  try {
    const sp = S();
    if (!sp?.PopupModal?.display || !sp?.React?.createElement) return;
    const lang = currentLang(hooks.storage());
    sp.PopupModal.display({
      title: panelText(lang, "title"),
      content: buildPanel(hooks),
      isLarge: false,
    });
  } catch (e) {
    console.error("[WhatsThatGenre] settings panel failed", e);
  }
}

/** Registers the Topbar button; silently skipped when the API is absent. */
export function registerSettingsButton(hooks: PanelHooks): boolean {
  try {
    const Btn = S()?.Topbar?.Button;
    if (typeof Btn !== "function") return false;
    new Btn("WTG", "settings", () => openPanel(hooks));
    return true;
  } catch {
    return false;
  }
}
