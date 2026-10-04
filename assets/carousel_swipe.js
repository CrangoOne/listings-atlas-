/**
 * Discrete horizontal swipe helpers for Atlas carousels / pagers.
 *
 * Keeps the show/hide slide model — no translateX drag preview.
 */

const DEFAULT_THRESHOLD_PX = 48;
const AXIS_RATIO = 1.25; // |dx| must exceed |dy| * ratio

function isInteractiveTarget(el) {
  if (!el || typeof el.closest !== "function") return false;
  return Boolean(
    el.closest(
      "button, a, input, select, textarea, label, summary, [role='button'], [contenteditable='true']"
    )
  );
}

/**
 * Bind discrete left/right swipe on a surface.
 *
 * @param {HTMLElement | null} surface
 * @param {{
 *   onPrev: () => void,
 *   onNext: () => void,
 *   ignoreSelector?: string,
 *   thresholdPx?: number,
 * }} opts
 */
export function bindCarouselSwipe(surface, opts) {
  if (!surface || typeof opts?.onPrev !== "function" || typeof opts?.onNext !== "function") {
    return;
  }
  if (surface.dataset.swipeBound === "1") return;
  surface.dataset.swipeBound = "1";

  const threshold = Number(opts.thresholdPx) > 0 ? Number(opts.thresholdPx) : DEFAULT_THRESHOLD_PX;
  const ignoreSelector = opts.ignoreSelector || "";

  let pointerId = null;
  let startX = 0;
  let startY = 0;
  let tracking = false;

  const reset = () => {
    pointerId = null;
    tracking = false;
  };

  surface.addEventListener(
    "pointerdown",
    (e) => {
      if (e.pointerType === "mouse" && e.button !== 0) return;
      if (pointerId != null) return;
      const target = e.target;
      if (isInteractiveTarget(target)) return;
      if (
        ignoreSelector &&
        target &&
        typeof target.closest === "function" &&
        target.closest(ignoreSelector)
      ) {
        return;
      }
      pointerId = e.pointerId;
      startX = e.clientX;
      startY = e.clientY;
      tracking = true;
      try {
        surface.setPointerCapture?.(e.pointerId);
      } catch {
        /* ignore unsupported capture */
      }
    },
    { passive: true }
  );

  surface.addEventListener(
    "pointerup",
    (e) => {
      if (!tracking || e.pointerId !== pointerId) return;
      const dx = e.clientX - startX;
      const dy = e.clientY - startY;
      reset();
      if (Math.abs(dx) < threshold) return;
      if (Math.abs(dx) < Math.abs(dy) * AXIS_RATIO) return;
      if (dx < 0) opts.onNext();
      else opts.onPrev();
    },
    { passive: true }
  );

  surface.addEventListener(
    "pointercancel",
    (e) => {
      if (e.pointerId === pointerId) reset();
    },
    { passive: true }
  );
}
