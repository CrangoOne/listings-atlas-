/**
 * Listings Atlas display timezone.
 * Stored timestamps remain UTC (ISO Z); UI shows Europe/Vienna.
 * In summer de-AT labels this MESZ (CEST); in winter MEZ (CET).
 */
export const DISPLAY_TZ = "Europe/Vienna";
export const TZ_HINT = "Wien (CET/CEST)";

const WHEN_OPTS = {
  timeZone: DISPLAY_TZ,
  year: "numeric",
  month: "short",
  day: "numeric",
  hour: "2-digit",
  minute: "2-digit",
  timeZoneName: "short",
};

const WHEN_COMPACT_OPTS = {
  timeZone: DISPLAY_TZ,
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
  hour: "2-digit",
  minute: "2-digit",
};

function compactFromParts(d) {
  const parts = new Intl.DateTimeFormat("de-AT", WHEN_COMPACT_OPTS).formatToParts(d);
  const get = (type) => parts.find((p) => p.type === type)?.value || "";
  return `${get("day")}.${get("month")}.${get("year")} ${get("hour")}:${get("minute")}`;
}

/** Format ISO UTC timestamp for Atlas boards (Vienna local). */
export function formatWhen(iso) {
  if (!iso) return "—";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return String(iso);
  return d.toLocaleString("de-AT", WHEN_OPTS);
}

/** Compact Vienna stamp for tight KPI cells: ``25.08.2026 00:07``. */
export function formatWhenCompact(iso) {
  if (!iso) return "—";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return String(iso);
  return compactFromParts(d);
}

/** Escape HTML then format — for untrusted or mixed HTML contexts. */
export function formatWhenHtml(iso) {
  if (!iso) return "—";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) {
    return String(iso)
      .replaceAll("&", "&amp;")
      .replaceAll("<", "&lt;")
      .replaceAll(">", "&gt;");
  }
  return d.toLocaleString("de-AT", WHEN_OPTS);
}
