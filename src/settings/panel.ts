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

export const TOPBAR_TITLE = "What's That Genre? Plus";

const S = () => (globalThis as any).Spicetify as any;

function currentUri(): string {
  try {
    return String(S()?.Player?.data?.item?.uri ?? "");
  } catch {
    return "";
  }
}

/** Move `first` to the front, keep the others in their current order. */
export function promoteSource(order: SourceId[], first: SourceId): SourceId[] {
  return [first, ...order.filter((x) => x !== first)];
}

export function buildPanel(hooks: PanelHooks): unknown {
  const R = S().React;
  const h = R.createElement as (...a: unknown[]) => unknown;
  const Panel = () => {
    const [, bump] = R.useState(0);
    const rerender = () => bump((n: number) => n + 1);
    const [armed, setArmed] = R.useState(false);
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
    const ctl = {
      color: "var(--spice-text)",
      background: "var(--spice-main)",
      border: "1px solid var(--spice-button-disabled)",
      borderRadius: 4,
      padding: "6px 10px",
      font: "inherit",
    };
    const btn = (label: string, onClick: () => void, extra = {}) =>
      h(
        "button",
        {
          type: "button",
          onClick,
          style: { ...ctl, cursor: "pointer", ...extra },
        },
        label,
      );
    const primary = {
      background: "var(--spice-button)",
      color: "var(--spice-main)",
      border: "none",
      fontWeight: 700,
    };
    const hint = (text: string) =>
      h("div", { style: { opacity: 0.7, marginTop: 4 } }, text);
    const section = (title: string, ...kids: unknown[]) =>
      h(
        "section",
        { "data-wtg-section": "1", style: { margin: "0 0 20px" } },
        h(
          "h3",
          { style: { margin: "0 0 8px", fontSize: 15, fontWeight: 700 } },
          title,
        ),
        ...kids,
      );

    const sourceSelect = h(
      "select",
      {
        "aria-label": t("sourceFirst"),
        value: settings.sourceOrder[0],
        style: { ...ctl, width: "100%" },
        onChange: (e: any) =>
          update({
            sourceOrder:
              validSourceOrder(
                promoteSource(settings.sourceOrder, e.target.value as SourceId),
              ) ?? settings.sourceOrder,
          }),
      },
      SOURCE_IDS.map((id) =>
        h("option", { key: id, value: id }, t(`source_${id}` as PanelKey)),
      ),
    );
    const langSelect = h(
      "select",
      {
        "aria-label": t("secLang"),
        value: settings.lang,
        style: { ...ctl, width: "100%" },
        onChange: (e: any) => update({ lang: e.target.value as LangSetting }),
      },
      h("option", { value: "auto" }, t("langAuto")),
      h("option", { value: "tr" }, "Türkçe"),
      h("option", { value: "en" }, "English"),
    );
    const manualInput = h("input", {
      type: "text",
      "aria-label": t("secTrack"),
      style: { ...ctl, flex: 1, minWidth: 0 },
      placeholder: uri ? t("manualPlaceholder") : t("noTrack"),
      disabled: !uri,
      value: manual !== "" ? manual : (saved ?? ""),
      onChange: (e: any) => setManual(e.target.value),
    });
    const onSave = () => {
      const v = (manual !== "" ? manual : (saved ?? "")).trim();
      if (!uri) return;
      if (v) setManualGenre(storage, uri, v);
      else removeManualGenre(storage, uri);
      setManual("");
      hooks.changed();
      rerender();
    };

    return h(
      "div",
      {
        "data-wtg-panel": "1",
        style: {
          color: "var(--spice-text)",
          width: 520,
          maxWidth: "100%",
          fontSize: 13,
          lineHeight: 1.5,
        },
      },
      section(t("secSource"), sourceSelect, hint(t("descSource"))),
      section(t("secLang"), langSelect, hint(t("descLang"))),
      section(
        t("secTrack"),
        h(
          "div",
          { style: { display: "flex", gap: 8 } },
          manualInput,
          btn(t("save"), onSave, primary),
        ),
        hint(t("descTrack")),
        h(
          "div",
          { style: { marginTop: 12 } },
          btn(t("refreshNow"), () => hooks.refreshNow()),
          hint(t("descRefresh")),
        ),
      ),
      h(
        "div",
        {
          style: {
            borderTop: "1px solid var(--spice-button-disabled)",
            paddingTop: 16,
          },
        },
        btn(armed ? t("confirm") : t("clearCache"), () => {
          if (!armed) {
            setArmed(true);
            setTimeout(() => setArmed(false), 4000);
            return;
          }
          setArmed(false);
          clearWtgCache(storage);
          hooks.changed();
        }),
        hint(t("descClear")),
      ),
      h(
        "div",
        { style: { opacity: 0.5, fontSize: 11, marginTop: 20 } },
        `${t("version")} ${PACKAGE_VERSION}`,
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

/** settings -> gear -> equalizer -> first known key; undefined when none. */
export function pickSettingsIcon(icons: any): string | undefined {
  if (!icons || typeof icons !== "object") return undefined;
  for (const k of ["settings", "gear", "equalizer"])
    if (icons[k]) return icons[k];
  const first = Object.keys(icons).find((k) => icons[k]);
  return first ? icons[first] : undefined;
}

/** Registers the Topbar button (icon fallback chain, then Menu.Item); never throws. */
export function registerSettingsButton(hooks: PanelHooks): boolean {
  try {
    const sp = S();
    const Btn = sp?.Topbar?.Button;
    const icon0 = pickSettingsIcon(sp?.SVGIcons);
    if (typeof Btn !== "function" || !icon0) {
      if (typeof sp?.Menu?.Item === "function") {
        new sp.Menu.Item(TOPBAR_TITLE, false, () => openPanel(hooks));
        return true;
      }
      console.info("[WTG] settings button: no API");
      return false;
    }
    const b = new Btn(TOPBAR_TITLE, icon0, () => openPanel(hooks));
    try {
      const el = b?.element as HTMLElement | undefined;
      el?.setAttribute?.("title", TOPBAR_TITLE);
      el?.setAttribute?.("aria-label", TOPBAR_TITLE);
    } catch {}
    return true;
  } catch {
    return false;
  }
}
