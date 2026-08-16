import { initExplore } from "./explore.js";
import { initCrawls } from "./crawls.js";
import { initSources } from "./sources.js";

const fmt = new Intl.NumberFormat("en-US");
const euro = new Intl.NumberFormat("en-US", {
  style: "currency",
  currency: "EUR",
  maximumFractionDigits: 0,
});

const SOURCE_LABEL = {
  willhaben: "Willhaben",
  autoscout: "AutoScout24",
  kleinanzeigen: "Kleinanzeigen",
  coches: "coches.net",
};

function niceSource(id) {
  return SOURCE_LABEL[id] || id;
}

function renderBars(el, items, { labelKey = "label", valueKey = "count", max = null } = {}) {
  if (!el) return;
  const peak = max ?? Math.max(...items.map((d) => Number(d[valueKey]) || 0), 1);
  el.innerHTML = items
    .map((d) => {
      const label = d[labelKey];
      const value = Number(d[valueKey]) || 0;
      const pct = Math.max(1.5, (value / peak) * 100);
      return `<div class="bar-row">
        <span class="bar-name" title="${escapeHtml(String(label))}">${escapeHtml(String(label))}</span>
        <div class="bar-track"><div class="bar-fill" data-width="${pct.toFixed(2)}"></div></div>
        <span class="bar-val">${fmt.format(value)}</span>
      </div>`;
    })
    .join("");

  requestAnimationFrame(() => {
    el.querySelectorAll(".bar-fill").forEach((fill) => {
      fill.style.width = `${fill.dataset.width}%`;
    });
  });
}

function escapeHtml(s) {
  return s
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

function renderKpis(data) {
  const root = document.getElementById("kpi-row");
  const by = Object.fromEntries(data.by_source.map((d) => [d.source, d.count]));
  const avg = data.price_stats?.avg_price;
  const items = [
    { label: "All listings", value: fmt.format(data.total), sub: "merged unique ads" },
    {
      label: "Kleinanzeigen",
      value: fmt.format(by.kleinanzeigen || 0),
      sub: share(by.kleinanzeigen, data.total),
    },
    {
      label: "coches.net",
      value: fmt.format(by.coches || 0),
      sub: share(by.coches, data.total),
    },
    {
      label: "Avg. price",
      value: avg ? euro.format(avg) : "—",
      sub: "€500–€200k filter",
    },
  ];
  root.innerHTML = items
    .map(
      (k) => `<div class="kpi">
        <span class="label">${k.label}</span>
        <span class="value">${k.value}</span>
        <span class="sub">${k.sub}</span>
      </div>`
    )
    .join("");
}

function share(part, total) {
  if (!part || !total) return "—";
  return `${((part / total) * 100).toFixed(1)}% of pack`;
}

function renderMarketMakes(data) {
  const root = document.getElementById("market-makes");
  const order = ["kleinanzeigen", "willhaben", "autoscout", "coches"];
  root.innerHTML = order
    .map((source) => {
      const rows = data.makes_by_source?.[source] || [];
      if (!rows.length) return "";
      const id = `makes-${source}`;
      return `<div class="market-panel">
        <h3>${niceSource(source)}</h3>
        <div id="${id}" class="bar-chart"></div>
      </div>`;
    })
    .join("");

  for (const source of order) {
    const rows = (data.makes_by_source?.[source] || []).map((d) => ({
      label: d.make,
      count: d.count,
    }));
    if (!rows.length) continue;
    renderBars(document.getElementById(`makes-${source}`), rows);
  }
}

async function main() {
  const res = await fetch("data/summary.json", { cache: "no-cache" });
  if (!res.ok) throw new Error(`Failed to load summary.json (${res.status})`);
  const data = await res.json();

  renderKpis(data);

  renderBars(
    document.getElementById("source-bars"),
    data.by_source.map((d) => ({ label: niceSource(d.source), count: d.count }))
  );

  renderBars(
    document.getElementById("price-bars"),
    data.price_buckets.map((d) => ({ label: d.bucket, count: d.count }))
  );

  renderBars(
    document.getElementById("price-source"),
    data.price_by_source.map((d) => ({
      label: niceSource(d.source),
      count: d.avg_price || 0,
    })),
    { valueKey: "count" }
  );
  // Relabel values as currency in the price-by-source chart
  document.querySelectorAll("#price-source .bar-val").forEach((el, i) => {
    const v = data.price_by_source[i]?.avg_price;
    el.textContent = v ? euro.format(v) : "—";
  });

  renderBars(
    document.getElementById("year-bars"),
    data.by_year.map((d) => ({ label: String(d.year), count: d.count }))
  );
  document.getElementById("year-bars").classList.add("dense");

  renderBars(
    document.getElementById("make-bars"),
    data.top_makes.slice(0, 20).map((d) => ({ label: d.make, count: d.count }))
  );

  renderBars(
    document.getElementById("fuel-bars"),
    data.by_fuel.map((d) => ({ label: d.label, count: d.count }))
  );

  renderBars(
    document.getElementById("trans-bars"),
    data.by_transmission.map((d) => ({ label: d.label, count: d.count }))
  );

  renderMarketMakes(data);

  const meta = document.getElementById("generated-meta");
  meta.textContent = `Summary generated ${data.generated_at} from ${data.db_file} · ${fmt.format(data.total)} listings`;

  initExplore(data);
  initSources();
  initCrawls();
  wireBoardRefresh();
}

function wireBoardRefresh() {
  const buttons = document.querySelectorAll(".board-refresh");
  buttons.forEach((btn) => {
    btn.addEventListener("click", async () => {
      const board = btn.dataset.board;
      const label = btn.textContent;
      btn.disabled = true;
      btn.textContent = "Refreshing…";
      try {
        if (board === "sources") await initSources();
        else if (board === "crawls") await initCrawls();
      } finally {
        btn.disabled = false;
        btn.textContent = label || "Refresh";
      }
    });
  });
}

main().catch((err) => {
  const meta = document.getElementById("generated-meta");
  meta.textContent = `Could not load dashboard data: ${err.message}`;
  console.error(err);
});
