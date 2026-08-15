const SOURCE_ORDER = ["willhaben", "autoscout", "kleinanzeigen", "coches"];

const SOURCE_LABEL = {
  willhaben: "Willhaben",
  autoscout: "AutoScout24",
  kleinanzeigen: "Kleinanzeigen",
  coches: "coches.net",
};

const fmt = new Intl.NumberFormat("en-US");

function escapeHtml(s) {
  return String(s ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

function niceSource(id) {
  return SOURCE_LABEL[id] || id || "—";
}

function formatWhen(iso) {
  if (!iso) return "—";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return escapeHtml(String(iso));
  return d.toLocaleString(undefined, {
    year: "numeric",
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

function formatDateSpan(min, max) {
  if (!min && !max) return "—";
  if (min && max && min === max) return escapeHtml(String(min));
  if (min && max) return `${escapeHtml(String(min))} → ${escapeHtml(String(max))}`;
  return escapeHtml(String(min || max));
}

function qualityRows(columns) {
  const entries = Object.entries(columns || {});
  entries.sort((a, b) => (a[1].fill_pct ?? 0) - (b[1].fill_pct ?? 0));
  return entries;
}

function renderSourceCard(id, src) {
  const dates = src.dates || {};
  const last = src.last_crawl || null;
  const cols = qualityRows(src.columns);
  const lastWhen = last?.finished_at || last?.started_at;
  const lastLabel = last
    ? `${formatWhen(lastWhen)} · ${escapeHtml(last.status || "—")}${
        last.job_id ? ` · ${escapeHtml(last.job_id)}` : ""
      }`
    : "No crawl_status row yet";

  const qualityHtml = cols.length
    ? `<div class="source-quality">
        <div class="chart-label">Column fill rates</div>
        <div class="bar-chart source-quality-bars">
          ${cols
            .map(([name, q]) => {
              const pct = Number(q.fill_pct) || 0;
              const width = Math.max(1.5, pct);
              return `<div class="bar-row">
                <span class="bar-name" title="${escapeHtml(name)}">${escapeHtml(name)}</span>
                <div class="bar-track"><div class="bar-fill" data-width="${width.toFixed(2)}"></div></div>
                <span class="bar-val">${pct.toFixed(1)}%</span>
              </div>`;
            })
            .join("")}
        </div>
      </div>`
    : `<p class="source-empty">No rows in the consolidated DB for this source.</p>`;

  return `<article class="source-card" id="source-${escapeHtml(id)}">
    <header class="source-card-head">
      <h3>${escapeHtml(src.label || niceSource(id))}</h3>
      <p class="source-rows">${fmt.format(src.rows || 0)} listings</p>
    </header>
    <dl class="source-meta">
      <div><dt>Last crawl</dt><dd>${lastLabel}</dd></div>
      <div><dt>Scraped coverage</dt><dd>${formatDateSpan(dates.scraped_at_min, dates.scraped_at_max)}</dd></div>
      <div><dt>Listing “Updated”</dt><dd>${formatDateSpan(dates.updated_min, dates.updated_max)}</dd></div>
      ${
        last?.rows_added != null
          ? `<div><dt>Last rows added</dt><dd>+${fmt.format(last.rows_added)}</dd></div>`
          : ""
      }
    </dl>
    ${qualityHtml}
  </article>`;
}

function renderSourcesKpis(payload) {
  const root = document.getElementById("sources-kpis");
  if (!root) return;
  const sources = payload.sources || {};
  const present = Object.values(sources).filter((s) => (s.rows || 0) > 0).length;
  const items = [
    {
      label: "Listings in pack",
      value: fmt.format(payload.total || 0),
      sub: payload.db_file || "consolidated DB",
    },
    {
      label: "Sources",
      value: String(present),
      sub: "with rows in the pack",
    },
    {
      label: "Generated",
      value: formatWhen(payload.generated_at),
      sub: "sources_summary.json",
    },
  ];
  root.innerHTML = items
    .map(
      (k) => `<div class="kpi">
        <span class="label">${k.label}</span>
        <span class="value">${k.value}</span>
        <span class="sub">${escapeHtml(k.sub)}</span>
      </div>`
    )
    .join("");
}

export async function initSources() {
  const meta = document.getElementById("sources-meta");
  const root = document.getElementById("sources-board");
  try {
    const res = await fetch("data/sources_summary.json", { cache: "no-cache" });
    if (!res.ok) throw new Error(`sources_summary.json (${res.status})`);
    const payload = await res.json();
    renderSourcesKpis(payload);

    const sources = payload.sources || {};
    const order = [
      ...SOURCE_ORDER.filter((id) => id in sources),
      ...Object.keys(sources).filter((id) => !SOURCE_ORDER.includes(id)),
    ];
    if (root) {
      root.innerHTML = order.map((id) => renderSourceCard(id, sources[id])).join("");
      requestAnimationFrame(() => {
        root.querySelectorAll(".bar-fill").forEach((fill) => {
          fill.style.width = `${fill.dataset.width}%`;
        });
      });
    }
    if (meta) {
      meta.textContent = `${fmt.format(payload.total || 0)} listings across ${order.length} sources · ${
        payload.db_file || "listings.db"
      }`;
    }
  } catch (err) {
    if (root) root.innerHTML = "";
    if (meta) meta.textContent = `Could not load sources board: ${err.message}`;
    console.error(err);
  }
}
