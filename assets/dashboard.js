import { initExplore } from "./explore.js?v=20260821b";
import { initCrawls, startCrawlsAutoRefresh } from "./crawls.js?v=20260827c";
import { initSources } from "./sources.js?v=20260827c";
import { formatWhen, TZ_HINT } from "./time_display.js?v=20260827c";

const fmt = new Intl.NumberFormat("en-US");
const euro = new Intl.NumberFormat("en-US", {
  style: "currency",
  currency: "EUR",
  maximumFractionDigits: 0,
});

/** Prefer freshest pack KPI JSON (Pages can lag behind raw GitHub). */
const LIVE_SUMMARY_URLS = [
  "data/summary.json",
  "https://raw.githubusercontent.com/CrangoOne/listings-atlas-/main/data/summary.json",
];

function withCacheBust(url) {
  const sep = url.includes("?") ? "&" : "?";
  return `${url}${sep}t=${Date.now()}&r=${Math.random().toString(36).slice(2, 8)}`;
}

async function fetchSummaryPreferLive() {
  const results = await Promise.allSettled(
    LIVE_SUMMARY_URLS.map(async (url) => {
      const res = await fetch(withCacheBust(url), {
        cache: "no-store",
        headers: { Accept: "application/json" },
      });
      if (!res.ok) throw new Error(`${url} (${res.status})`);
      return { data: await res.json(), url: res.url || url };
    })
  );
  const ok = results
    .filter((r) => r.status === "fulfilled")
    .map((r) => r.value)
    .filter((v) => v?.data && typeof v.data === "object");
  if (!ok.length) {
    const last = results.find((r) => r.status === "rejected");
    throw last?.reason || new Error("Could not load summary.json");
  }
  ok.sort(
    (a, b) =>
      (Date.parse(b.data.generated_at) || 0) - (Date.parse(a.data.generated_at) || 0)
  );
  return ok[0];
}

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

const MARKETS_SLIDES = [
  { id: "overview", label: "Overview" },
  { id: "by-source", label: "By source" },
];

function renderMarketsCarouselShell() {
  const tabs = MARKETS_SLIDES.map(
    (slide, idx) =>
      `<button type="button" class="carousel-tab${idx === 0 ? " is-active" : ""}" data-index="${idx}" role="tab" aria-selected="${
        idx === 0 ? "true" : "false"
      }" aria-controls="markets-${slide.id}">${slide.label}</button>`
  ).join("");

  const slides = MARKETS_SLIDES.map(
    (slide, idx) =>
      `<article class="carousel-slide markets-slide" id="markets-${slide.id}" data-slide-id="${slide.id}"></article>`
  ).join("");

  const dots = MARKETS_SLIDES.map(
    (_, idx) =>
      `<button type="button" class="carousel-dot${idx === 0 ? " is-active" : ""}" data-index="${idx}" aria-label="${MARKETS_SLIDES[idx].label}"></button>`
  ).join("");

  return `<div class="sources-carousel markets-carousel" data-slide-count="${MARKETS_SLIDES.length}">
    <div class="carousel-toolbar">
      <div class="carousel-tabs" role="tablist">${tabs}</div>
      <div class="carousel-nav">
        <button type="button" class="btn ghost carousel-prev" aria-label="Previous view">←</button>
        <span class="carousel-counter">1 / ${MARKETS_SLIDES.length}</span>
        <button type="button" class="btn ghost carousel-next" aria-label="Next view">→</button>
      </div>
    </div>
    <div class="carousel-viewport">
      <div class="carousel-track">${slides}</div>
    </div>
    <div class="carousel-dots" role="group" aria-label="Market views">${dots}</div>
  </div>`;
}

function initMarketsCarousel(root) {
  const carousel = root.querySelector(".markets-carousel");
  if (!carousel) return;

  const track = carousel.querySelector(".carousel-track");
  const tabs = [...carousel.querySelectorAll(".carousel-tab")];
  const dots = [...carousel.querySelectorAll(".carousel-dot")];
  const counter = carousel.querySelector(".carousel-counter");
  const prevBtn = carousel.querySelector(".carousel-prev");
  const nextBtn = carousel.querySelector(".carousel-next");
  const slideCount = Number(carousel.dataset.slideCount) || tabs.length;
  let current = 0;

  function goTo(index) {
    if (!slideCount) return;
    current = ((index % slideCount) + slideCount) % slideCount;
    track.style.transform = `translateX(-${current * 100}%)`;

    tabs.forEach((tab, idx) => {
      const active = idx === current;
      tab.classList.toggle("is-active", active);
      tab.setAttribute("aria-selected", active ? "true" : "false");
    });
    dots.forEach((dot, idx) => dot.classList.toggle("is-active", idx === current));
    if (counter) counter.textContent = `${current + 1} / ${slideCount}`;
    if (prevBtn) prevBtn.disabled = slideCount <= 1;
    if (nextBtn) nextBtn.disabled = slideCount <= 1;

    const activeSlide = track.children[current];
    if (activeSlide) {
      requestAnimationFrame(() => {
        activeSlide.querySelectorAll(".bar-fill").forEach((fill) => {
          fill.style.width = `${fill.dataset.width}%`;
        });
      });
    }
  }

  tabs.forEach((tab) => tab.addEventListener("click", () => goTo(Number(tab.dataset.index))));
  dots.forEach((dot) => dot.addEventListener("click", () => goTo(Number(dot.dataset.index))));
  prevBtn?.addEventListener("click", () => goTo(current - 1));
  nextBtn?.addEventListener("click", () => goTo(current + 1));

  carousel.addEventListener("keydown", (e) => {
    if (e.key === "ArrowLeft") {
      e.preventDefault();
      goTo(current - 1);
    } else if (e.key === "ArrowRight") {
      e.preventDefault();
      goTo(current + 1);
    }
  });

  goTo(0);
}

function renderKpis(data, root) {
  if (!root) return;
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

function renderMarketsBoard(data) {
  const board = document.getElementById("markets-board");
  if (!board) return;

  board.innerHTML = renderMarketsCarouselShell();
  const overviewSlide = board.querySelector('[data-slide-id="overview"]');
  const bySourceSlide = board.querySelector('[data-slide-id="by-source"]');

  overviewSlide.innerHTML = `<div class="kpi-row" id="kpi-row"></div>`;
  bySourceSlide.innerHTML = `<div class="chart-block">
    <div class="chart-label">Listings by source</div>
    <div id="source-bars" class="bar-chart" role="img" aria-label="Listings by source"></div>
  </div>`;

  renderKpis(data, overviewSlide.querySelector("#kpi-row"));
  renderBars(
    bySourceSlide.querySelector("#source-bars"),
    data.by_source.map((d) => ({ label: niceSource(d.source), count: d.count }))
  );
  initMarketsCarousel(board);
}

async function main() {
  const pack = await fetchSummaryPreferLive();
  const data = pack.data;

  renderMarketsBoard(data);

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
  const generatedLabel = formatWhen(data.generated_at);
  meta.textContent = `Summary generated ${generatedLabel} (${TZ_HINT}) from ${data.db_file} · ${fmt.format(data.total)} listings`;

  initExplore(data);
  initSources();
  initCrawls();
  startCrawlsAutoRefresh(30000);
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
