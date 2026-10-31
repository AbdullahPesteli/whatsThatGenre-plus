/**
 * Locate the element the genre list should be attached to.
 *
 * Resolution order (first match wins, recorded in `dataset.wtgHost`):
 *   legacy  `.main-nowPlayingWidget-trackInfo`   (older clients, e.g. 1.2.74)
 *   widget  `[data-testid="now-playing-widget"]`
 *   bar     `[data-testid="now-playing-bar"]`
 *   links   structural scan inside the widget/bar (track + artist links)
 *   null    nothing found (caller warns once)
 */
export const LEGACY_HOST_SELECTOR = ".main-nowPlayingWidget-trackInfo";
export const WIDGET_SELECTOR = '[data-testid="now-playing-widget"]';
export const BAR_SELECTOR = '[data-testid="now-playing-bar"]';

export type HostKind = "legacy" | "widget" | "bar" | "links";

let lastLogged = "";

function mark(el: Element, kind: HostKind): Element {
  try {
    (el as HTMLElement).dataset.wtgHost = kind;
  } catch {
    /* non-HTML element */
  }
  if (lastLogged !== kind) {
    lastLogged = kind;
    console.info("[WTG] host:", kind);
  }
  return el;
}

export function resetHostLog(): void {
  lastLogged = "";
}

/** Structural resolution inside a widget/bar scope. */
function resolveInScope(scope: Element): Element {
  const trackLink =
    scope.querySelector<HTMLAnchorElement>('a[href*="/track/"]');
  const artistLink = scope.querySelector<HTMLAnchorElement>(
    'a[href*="/artist/"]',
  );
  if (trackLink && artistLink) {
    let node: Element = trackLink;
    while (
      node.parentElement &&
      node.parentElement !== scope &&
      !node.parentElement.contains(artistLink)
    ) {
      node = node.parentElement;
    }
    return node.parentElement && node.parentElement !== scope
      ? node.parentElement
      : node;
  }
  for (const child of Array.from(scope.children)) {
    if ((child.getAttribute("data-testid") ?? "").startsWith("CoverSlot"))
      continue;
    if ((child.textContent ?? "").trim()) return child;
  }
  return scope;
}

export function findTrackInfoHost(
  doc: Pick<Document, "querySelector"> = document,
): Element | null {
  const legacy = doc.querySelector(LEGACY_HOST_SELECTOR);
  if (legacy) return mark(legacy, "legacy");

  const widget = doc.querySelector(WIDGET_SELECTOR);
  const bar = widget ? null : doc.querySelector(BAR_SELECTOR);
  const scope = widget ?? bar;
  // No marker present: refuse to guess. Never fall back to document.body.
  if (!scope) return null;

  const hit = resolveInScope(scope);
  if (hit !== scope && scope.contains(hit) && hit.tagName) {
    // structural hit inside a testid scope
    return mark(hit, "links");
  }
  return mark(scope, widget ? "widget" : "bar");
}
