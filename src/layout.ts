/** Gap kept between the genre row and the progress bar, px. */
export const ROW_GAP = 4;

export interface RowPlacementInput {
  /** Offset height of the host: the default `top` (row directly under host). */
  hostHeight: number;
  /** Viewport top of the host. */
  hostTop: number;
  rowHeight: number;
  /** Viewport top of the progress bar (+Infinity when absent). */
  barTop: number;
  /** Viewport bottom of the nearest clipping ancestor (+Infinity when none). */
  clipBottom: number;
}

export interface RowPlacement {
  top: number;
  hidden: boolean;
  action: "keep" | "shifted" | "hidden";
  overlaps: boolean;
}

/**
 * Position first, hide never-by-default: if the row would hit the progress bar
 * (or an overflow clip) it is shifted up (clamped to >= 0). Only when it still
 * collides after shifting is it hidden (last resort -> tooltip fallback).
 */
export function placeRow(i: RowPlacementInput): RowPlacement {
  const defaultBottom = i.hostTop + i.hostHeight + i.rowHeight;
  const barLimit = i.barTop - ROW_GAP;
  const overlaps =
    defaultBottom > barLimit + 0.5 || defaultBottom > i.clipBottom + 0.5;
  if (!overlaps) {
    return { top: i.hostHeight, hidden: false, action: "keep", overlaps };
  }
  const limit = Math.min(barLimit, i.clipBottom);
  const maxTop = limit - i.rowHeight - i.hostTop;
  const top = Math.max(0, Math.min(i.hostHeight, maxTop));
  const stillOverlaps = i.hostTop + top + i.rowHeight > limit + 0.5;
  return stillOverlaps
    ? { top, hidden: true, action: "hidden", overlaps }
    : { top, hidden: false, action: "shifted", overlaps };
}

/** Gap between the host's bottom edge and the genre row, px. */
export const HOST_GAP = 2;
/** Minimum width reserved for genre labels next to the badge, px. */
export const MIN_TAGS_WIDTH = 48;

/**
 * `top` for an absolutely positioned row so its top edge sits at
 * hostRect.bottom + HOST_GAP in viewport space, expressed in the coordinate
 * space of its offset parent (parentTop = that parent's viewport top, incl. border).
 */
export function anchorTop(
  hostRect: { bottom: number },
  parentTop: number,
  gap = HOST_GAP,
): number {
  return hostRect.bottom + gap - parentTop;
}

/**
 * Row width: clamp(available) but never below badge + MIN_TAGS_WIDTH, so the
 * source badge always fits. Genre labels get whatever is left (they ellipsize).
 */
export function rowWidth(
  available: number,
  badgeWidth: number,
  min: number,
  max: number,
): { width: number; tagsWidth: number } {
  const floor = Math.max(min, badgeWidth + MIN_TAGS_WIDTH);
  const width = Math.max(floor, Math.min(max, available));
  return { width, tagsWidth: Math.max(0, width - badgeWidth) };
}

export interface Box {
  left: number;
  right: number;
  top: number;
  bottom: number;
}

export interface GeoInput {
  host: Box;
  /** null when the progress bar is absent. */
  bar: Box | null;
  rowHeight: number;
  /** Viewport bottom of the nearest clipping ancestor (+Infinity when none). */
  clipBottom?: number;
}

export interface GeoPlacement {
  /** Viewport top of the row. */
  top: number;
  overlaps: boolean;
  hidden: boolean;
  action: "keep" | "shifted" | "hidden";
}

/** Gap between the row's right edge and the progress bar, px. */
export const BAR_GAP = 8;

/**
 * Row placement from real rects. The row sits at host.bottom + 2; it is only
 * clamped (moved up) when it intersects the bar both vertically AND
 * horizontally; hidden only if it still collides after the clamp.
 */
export function placeRowGeo(i: GeoInput): GeoPlacement {
  const clip = i.clipBottom ?? Number.POSITIVE_INFINITY;
  const top = i.host.bottom + HOST_GAP;
  const bottom = top + i.rowHeight;
  const h = !!i.bar && i.host.left < i.bar.right && i.host.right > i.bar.left;
  const vBar = !!i.bar && bottom > i.bar.top + 0.5;
  const overlaps = (vBar && h) || bottom > clip + 0.5;
  if (!overlaps) return { top, overlaps, hidden: false, action: "keep" };
  const limit = Math.min(
    vBar && h && i.bar ? i.bar.top - ROW_GAP : Number.POSITIVE_INFINITY,
    clip,
  );
  const clamped = Math.min(top, limit - i.rowHeight);
  const still = clamped + i.rowHeight > limit + 0.5;
  return still
    ? { top: clamped, overlaps, hidden: true, action: "hidden" }
    : { top: clamped, overlaps, hidden: false, action: "shifted" };
}

/** Width ceiling: left of the bar minus gap, relative to host.left. */
export function barWidthCeiling(host: Box, bar: Box | null): number | null {
  return bar ? bar.left - BAR_GAP - host.left : null;
}

/** How many leading tags fit fully in `avail` (tags ellipsize beyond that). */
export function fullyVisibleTags(
  avail: number,
  tagWidths: number[],
  gap = 4,
): number {
  let used = 0;
  let n = 0;
  for (const w of tagWidths) {
    used += w + (n ? gap : 0);
    if (used > avail) break;
    n++;
  }
  return n;
}
