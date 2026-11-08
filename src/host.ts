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
    // The host must cover BOTH the track title and the artist. Return the
    // lowest common ancestor of the two links (their shared byline wrapper);
    // when the links are flat siblings that ancestor is the scope itself.
    for (
      let outer: Element | null = trackLink;
      outer && outer !== scope;
      outer = outer.parentElement
    ) {
      for (
        let inner: Element | null = artistLink;
        inner && inner !== scope;
        inner = inner.parentElement
      ) {
        if (outer === inner) return outer;
      }
    }
    return scope;
  }
  // No track/artist link pair: the host must hold the whole byline (title and
  // artist text). A single text line keeps the previous first-text-child
  // contract; flat sibling lines (title + artist) only ever share the scope.
  let line: Element | null = null;
  for (const child of Array.from(scope.children)) {
    if ((child.getAttribute("data-testid") ?? "").startsWith("CoverSlot"))
      continue;
    if ((child.textContent ?? "").trim()) {
      if (line) return scope;
      line = child;
    }
  }
  return line ?? scope;
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
