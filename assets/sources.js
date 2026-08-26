/** Bumped whenever sources-fetch logic changes — shown in board meta. */
const ASSET_BUILD = "20260826a";

const SOURCE_ORDER = ["willhaben", "autoscout", "kleinanzeigen", "coches"];

const SOURCE_LABEL = {
  willhaben: "Willhaben",
  autoscout: "AutoScout24",
  kleinanzeigen: "Kleinanzeigen",
  coches: "coches.net",
};

/** Column fill-rate rows per quality page. */
const QUALITY_PAGE_SIZE = 6;

/**
 * Live sources pack (newest first).
 *
 * Same-origin Pages can lag behind raw GitHub; prefer the freshest
 * generated_at across candidates (mirrors crawl board fetch logic).
 */
const LIVE_SOURCES_URLS = [
  "data/sources_summary.json",
  "https://raw.githubusercontent.com/CrangoOne/listings-atlas-/main/data/sources_summary.json",
];

/** Live crawl status — merged into last_crawl on every refresh. */
const LIVE_STATUS_URLS = [
  "data/crawl_status.json",
  "https://raw.githubusercontent.com/CrangoOne/listings-atlas-/main/data/crawl_status.json",
];

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

/** Display timestamps in Vienna local time (stored values stay UTC). */
const DISPLAY_TZ = "Europe/Vienna";

function formatWhen(iso) {
  if (!iso) return "—";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return escapeHtml(String(iso));
  return d.toLocaleString("de-AT", {
    timeZone: DISPLAY_TZ,
    year: "numeric",
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    timeZoneName: "short",
  });
}

function formatDateSpan(min, max) {
  if (!min && !max) return "—";
  if (min && max && min === max) return escapeHtml(String(min));
  if (min && max) return `${escapeHtml(String(min))} → ${escapeHtml(String(max))}`;
  return escapeHtml(String(min || max));
}

function withCacheBust(url) {
  const sep = url.includes("?") ? "&" : "?";
  return `${url}${sep}t=${Date.now()}&r=${Math.random().toString(36).slice(2, 8)}`;
}

function parseTimestamp(raw) {
  if (!raw) return 0;
  const ms = Date.parse(raw);
  return Number.isFinite(ms) ? ms : 0;
}

async function fetchOneJson(url) {
  const res = await fetch(withCacheBust(url), {
    cache: "no-store",
    headers: { Accept: "application/json" },
  });
  if (!res.ok) throw new Error(`${url} (${res.status})`);
  return { data: await res.json(), url: res.url || url };
}

async function fetchJsonPreferLive(liveUrls, timestampKey) {
  const results = await Promise.allSettled(liveUrls.map((u) => fetchOneJson(u)));
  const ok = results
    .filter((r) => r.status === "fulfilled")
    .map((r) => r.value)
    .filter((v) => v?.data && typeof v.data === "object");
  if (!ok.length) {
    const last = results.find((r) => r.status === "rejected");
    throw last?.reason || new Error("Could not load JSON");
  }
  ok.sort((a, b) => parseTimestamp(b.data[timestampKey]) - parseTimestamp(a.data[timestampKey]));
  return ok[0];
}

function lastCrawlScore(run) {
  const status = run?.status || "";
  const rank = status === "finished" ? 2 : status === "running" ? 1 : 0;
  return [rank, run?.finished_at || run?.started_at || ""];
}

function compactLastCrawl(run) {
  return {
    job_id: run.job_id,
    worker_id: run.worker_id,
    status: run.status,
    started_at: run.started_at,
    finished_at: run.finished_at,
    rows_added: run.rows_added,
    rows_total: run.rows_total,
    agent_url: run.agent_url,
    pr_url: run.pr_url,
    notes: run.notes,
  };
}

/** Latest finished (else latest any) crawl_status run per source — matches build_sources_summary.py. */
function loadLastCrawlsFromStatus(runs) {
  const best = {};
  for (const run of runs) {
    const source = run?.source;
    if (!source) continue;
    if (!best[source]) {
      best[source] = run;
      continue;
    }
    const score = lastCrawlScore(run);
    const prevScore = lastCrawlScore(best[source]);
    if (score[0] > prevScore[0] || (score[0] === prevScore[0] && score[1] > prevScore[1])) {
      best[source] = run;
    }
  }
  const out = {};
  for (const [source, run] of Object.entries(best)) {
    out[source] = compactLastCrawl(run);
  }
  return out;
}

function mergeLiveLastCrawls(payload, statusPayload) {
  const runs = Array.isArray(statusPayload?.runs) ? statusPayload.runs : [];
  const live = loadLastCrawlsFromStatus(runs);
  let merged = 0;
  for (const [sourceId, lastCrawl] of Object.entries(live)) {
    if (!payload.sources?.[sourceId]) continue;
    const existing = payload.sources[sourceId].last_crawl;
    const liveScore = lastCrawlScore(lastCrawl);
    const existingScore = existing ? lastCrawlScore(existing) : [-1, ""];
    if (liveScore[0] > existingScore[0] || (liveScore[0] === existingScore[0] && liveScore[1] > existingScore[1])) {
      payload.sources[sourceId].last_crawl = lastCrawl;
      merged += 1;
    }
  }
  return { merged, statusUpdatedAt: statusPayload?.updated_at || null };
}

function qualityRows(columns) {
  const entries = Object.entries(columns || {});
  entries.sort((a, b) => (a[1].fill_pct ?? 0) - (b[1].fill_pct ?? 0));
  return entries;
}

function renderQualityBarRow(name, q) {
  const pct = Number(q.fill_pct) || 0;
  const width = Math.max(1.5, pct);
  return `<div class="bar-row">
    <span class="bar-name" title="${escapeHtml(name)}">${escapeHtml(name)}</span>
    <div class="bar-track"><div class="bar-fill" data-width="${width.toFixed(2)}"></div></div>
    <span class="bar-val">${pct.toFixed(1)}%</span>
  </div>`;
}

function renderQualityPages(cols) {
  if (!cols.length) return "";
  const pages = [];
  for (let i = 0; i < cols.length; i += QUALITY_PAGE_SIZE) {
    pages.push(cols.slice(i, i + QUALITY_PAGE_SIZE));
  }
  const pageHtml = pages
    .map(
      (pageCols, idx) =>
        `<div class="quality-page${idx === 0 ? " is-active" : ""}" data-page="${idx}" ${
          idx === 0 ? "" : 'hidden'
        }>
          ${pageCols.map(([name, q]) => renderQualityBarRow(name, q)).join("")}
        </div>`
    )
    .join("");

  const totalPages = pages.length;
  const pager =
    totalPages > 1
      ? `<div class="quality-pager pager">
          <button type="button" class="btn ghost quality-prev" aria-label="Previous columns">←</button>
          <span class="quality-page-info">1–${Math.min(QUALITY_PAGE_SIZE, cols.length)} of ${cols.length}</span>
          <button type="button" class="btn ghost quality-next" aria-label="Next columns">→</button>
        </div>`
      : `<span class="quality-page-info quality-page-info--solo">${cols.length} columns</span>`;

  return `<div class="source-quality" data-total-pages="${totalPages}">
    <div class="quality-head">
      <div class="chart-label">Column fill rates</div>
      ${pager}
    </div>
    <div class="bar-chart source-quality-bars">
      ${pageHtml}
    </div>
  </div>`;
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
    ? renderQualityPages(cols)
    : `<p class="source-empty">No rows in the consolidated DB for this source.</p>`;

  return `<article class="source-card carousel-slide" id="source-${escapeHtml(id)}" data-source-id="${escapeHtml(id)}">
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

function renderSourcesCarousel(order, sources) {
  const tabs = order
    .map(
      (id, idx) =>
        `<button type="button" class="carousel-tab${idx === 0 ? " is-active" : ""}" data-index="${idx}" role="tab" aria-selected="${
          idx === 0 ? "true" : "false"
        }" aria-controls="source-${escapeHtml(id)}">${escapeHtml(sources[id].label || niceSource(id))}</button>`
    )
    .join("");

  const slides = order.map((id) => renderSourceCard(id, sources[id])).join("");
  const dots = order
    .map(
      (_, idx) =>
        `<button type="button" class="carousel-dot${idx === 0 ? " is-active" : ""}" data-index="${idx}" aria-label="Source ${
          idx + 1
        }"></button>`
    )
    .join("");

  return `<div class="sources-carousel" data-slide-count="${order.length}">
    <div class="carousel-toolbar">
      <div class="carousel-tabs" role="tablist">${tabs}</div>
      <div class="carousel-nav">
        <button type="button" class="btn ghost carousel-prev" aria-label="Previous source">←</button>
        <span class="carousel-counter">1 / ${order.length}</span>
        <button type="button" class="btn ghost carousel-next" aria-label="Next source">→</button>
      </div>
    </div>
    <div class="carousel-viewport">
      <div class="carousel-track" style="transform: translateX(0%)">${slides}</div>
    </div>
    <div class="carousel-dots" role="group" aria-label="Source slides">${dots}</div>
  </div>`;
}

function animateBarFills(root) {
  requestAnimationFrame(() => {
    root.querySelectorAll(".bar-fill").forEach((fill) => {
      fill.style.width = `${fill.dataset.width}%`;
    });
  });
}

function updateQualityPageInfo(qualityRoot, pageIndex, pageCount, totalCols) {
  const info = qualityRoot.querySelector(".quality-page-info");
  if (!info || info.classList.contains("quality-page-info--solo")) return;
  const start = pageIndex * QUALITY_PAGE_SIZE + 1;
  const end = Math.min((pageIndex + 1) * QUALITY_PAGE_SIZE, totalCols);
  info.textContent = `${start}–${end} of ${totalCols}`;
}

function setQualityPage(qualityRoot, pageIndex) {
  const pages = qualityRoot.querySelectorAll(".quality-page");
  if (!pages.length) return;
  const clamped = Math.max(0, Math.min(pageIndex, pages.length - 1));
  pages.forEach((page, idx) => {
    const active = idx === clamped;
    page.classList.toggle("is-active", active);
    page.hidden = !active;
  });
  qualityRoot.dataset.currentPage = String(clamped);

  const prev = qualityRoot.querySelector(".quality-prev");
  const next = qualityRoot.querySelector(".quality-next");
  if (prev) prev.disabled = clamped === 0;
  if (next) next.disabled = clamped >= pages.length - 1;

  const totalCols = Array.from(pages).reduce((n, p) => n + p.querySelectorAll(".bar-row").length, 0);
  updateQualityPageInfo(qualityRoot, clamped, pages.length, totalCols);
  animateBarFills(qualityRoot);
}

function initQualityPagers(root) {
  root.querySelectorAll(".source-quality").forEach((qualityRoot) => {
    const totalPages = Number(qualityRoot.dataset.totalPages) || 1;
    if (totalPages <= 1) return;

    qualityRoot.dataset.currentPage = "0";
    setQualityPage(qualityRoot, 0);

    qualityRoot.querySelector(".quality-prev")?.addEventListener("click", () => {
      const current = Number(qualityRoot.dataset.currentPage) || 0;
      setQualityPage(qualityRoot, current - 1);
    });
    qualityRoot.querySelector(".quality-next")?.addEventListener("click", () => {
      const current = Number(qualityRoot.dataset.currentPage) || 0;
      setQualityPage(qualityRoot, current + 1);
    });
  });
}

function initSourcesCarousel(root) {
  const carousel = root.querySelector(".sources-carousel");
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
    if (activeSlide) animateBarFills(activeSlide);
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

function renderSourcesKpis(payload, { statusUpdatedAt = null, mergedCrawls = 0 } = {}) {
  const root = document.getElementById("sources-kpis");
  if (!root) return;
  const sources = payload.sources || {};
  const present = Object.values(sources).filter((s) => (s.rows || 0) > 0).length;
  const crawlSub = statusUpdatedAt
    ? `crawl board ${formatWhen(statusUpdatedAt)}${mergedCrawls ? ` · ${mergedCrawls} updated` : ""}`
    : "crawl board not loaded";
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
      label: "Pack snapshot",
      value: formatWhen(payload.generated_at),
      sub: crawlSub,
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
    const [sourcesPack, statusPack] = await Promise.all([
      fetchJsonPreferLive(LIVE_SOURCES_URLS, "generated_at"),
      fetchJsonPreferLive(LIVE_STATUS_URLS, "updated_at").catch(() => null),
    ]);
    const payload = sourcesPack.data;
    const { merged, statusUpdatedAt } = statusPack?.data
      ? mergeLiveLastCrawls(payload, statusPack.data)
      : { merged: 0, statusUpdatedAt: null };

    renderSourcesKpis(payload, { statusUpdatedAt, mergedCrawls: merged });

    const sources = payload.sources || {};
    const order = [
      ...SOURCE_ORDER.filter((id) => id in sources),
      ...Object.keys(sources).filter((id) => !SOURCE_ORDER.includes(id)),
    ];
    if (root) {
      root.innerHTML = renderSourcesCarousel(order, sources);
      initSourcesCarousel(root);
      initQualityPagers(root);
      animateBarFills(root);
    }
    if (meta) {
      let source = "live";
      if (sourcesPack.url.includes("raw.githubusercontent.com")) source = "live raw";
      else if (sourcesPack.url.includes("data/sources_summary")) source = "live pages";
      const packWhen = payload.generated_at ? formatWhen(payload.generated_at) : "—";
      const crawlWhen = statusUpdatedAt ? formatWhen(statusUpdatedAt) : "—";
      meta.textContent = `${fmt.format(payload.total || 0)} listings across ${order.length} sources · pack ${packWhen} · crawls ${crawlWhen} · ${source} · UI ${ASSET_BUILD}`;
    }
  } catch (err) {
    if (root) root.innerHTML = "";
    if (meta) meta.textContent = `Could not load sources board: ${err.message}`;
    console.error(err);
  }
}
