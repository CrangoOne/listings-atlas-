import {
  loadWebhookSettings,
  saveWebhookSettings,
  lastWaveId,
  rememberWaveId,
  buildWavePayload,
  postCrawlWave,
} from "./crawl_wave.js?v=20260827c";
import {
  SOURCE_ORDER,
  SOURCE_LABEL,
  SOURCE_SHARD_JOB,
  SOURCE_MAKES_KEY,
  buildStaleSummary,
  planWaveJobs,
  lastSourceCrawl,
} from "./crawl_stale.js?v=20260827a";
import { formatWhen, formatWhenHtml, TZ_HINT } from "./time_display.js?v=20260827a";

/** Bumped whenever status-fetch logic changes — shown in board meta. */
const ASSET_BUILD = "20260827c";

const STATUS_ORDER = ["running", "unspawned", "queued", "failed", "finished", "cancelled"];
const DEFAULT_FRESH_HOURS = 168;
const DEFAULT_WORKERS = 5;

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

/** running/queued without agent_url = dispatcher never spawned a worker. */
function isUnspawned(run) {
  const s = run?.status || "queued";
  if (s !== "running" && s !== "queued") return false;
  return !String(run?.agent_url || "").trim();
}

function displayStatus(run) {
  return isUnspawned(run) ? "unspawned" : run?.status || "queued";
}

function countByStatus(runs) {
  const out = {
    running: 0,
    unspawned: 0,
    queued: 0,
    finished: 0,
    failed: 0,
    cancelled: 0,
  };
  for (const r of runs) {
    const s = displayStatus(r);
    if (s in out) out[s] += 1;
    else out.queued += 1;
  }
  return out;
}

function renderCrawlKpis(runs, updatedAt) {
  const root = document.getElementById("crawl-kpis");
  if (!root) return;
  const counts = countByStatus(runs);
  const items = [
    {
      label: "Runs",
      value: String(runs.length),
      sub: updatedAt ? `Updated ${formatWhen(updatedAt)}` : "No status yet",
    },
    { label: "Running", value: String(counts.running), sub: "spawned workers" },
    {
      label: "Unspawned",
      value: String(counts.unspawned),
      sub: counts.unspawned ? "stamped, no agent" : "none",
    },
    { label: "Queued", value: String(counts.queued), sub: "waiting" },
    {
      label: "Finished",
      value: String(counts.finished),
      sub: `${counts.failed} failed`,
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

function sortRuns(runs) {
  return [...runs].sort((a, b) => {
    const sa = STATUS_ORDER.indexOf(displayStatus(a));
    const sb = STATUS_ORDER.indexOf(displayStatus(b));
    if (sa !== sb) return (sa < 0 ? 99 : sa) - (sb < 0 ? 99 : sb);
    const ta = Date.parse(a.started_at || a.finished_at || "") || 0;
    const tb = Date.parse(b.started_at || b.finished_at || "") || 0;
    return tb - ta;
  });
}

function linkCell(url, label) {
  if (!url) return "—";
  return `<a href="${escapeHtml(url)}" target="_blank" rel="noopener noreferrer">${escapeHtml(label)}</a>`;
}

function renderRunsTable(runs) {
  const body = document.getElementById("crawl-runs-body");
  const empty = document.getElementById("crawl-empty");
  if (!body) return;

  if (!runs.length) {
    body.innerHTML = "";
    if (empty) empty.hidden = false;
    return;
  }
  if (empty) empty.hidden = true;

  body.innerHTML = sortRuns(runs)
    .map((r) => {
      const makes = Array.isArray(r.makes) && r.makes.length ? r.makes.join(", ") : "—";
      const rows =
        r.rows_added != null
          ? `+${Number(r.rows_added).toLocaleString()}`
          : r.rows_total != null
            ? Number(r.rows_total).toLocaleString()
            : "—";
      const status = displayStatus(r);
      const statusNote =
        status === "unspawned"
          ? ' title="Stamped running/queued but no cloud agent URL — worker never started"'
          : "";
      return `<tr>
        <td><span class="crawl-status crawl-status--${escapeHtml(status)}"${statusNote}>${escapeHtml(status)}</span></td>
        <td>
          <div class="crawl-job">${escapeHtml(r.job_id || "—")}</div>
          <div class="crawl-meta">${escapeHtml(r.worker_id || "")}${
            r.wave_id ? ` · ${escapeHtml(r.wave_id)}` : ""
          }</div>
        </td>
        <td>${escapeHtml(niceSource(r.source))}</td>
        <td class="crawl-makes" title="${escapeHtml(makes)}">${escapeHtml(makes)}</td>
        <td>${formatWhenHtml(r.started_at)}</td>
        <td>${formatWhenHtml(r.finished_at)}</td>
        <td class="num">${escapeHtml(String(rows))}</td>
        <td class="crawl-links">
          ${linkCell(r.agent_url, "Agent")}
          ${r.agent_url && r.pr_url ? " · " : ""}
          ${linkCell(r.pr_url, "PR")}
        </td>
      </tr>`;
    })
    .join("");
}

function setWaveStatus(message, { error = false } = {}) {
  const el = document.getElementById("crawl-wave-status");
  if (!el) return;
  el.hidden = !message;
  el.textContent = message || "";
  el.classList.toggle("crawl-wave-status--error", Boolean(error));
}

function readSourceParams(sourceId) {
  const card = document.querySelector(`[data-crawl-source="${sourceId}"]`);
  if (!card) return { include: false, workers: DEFAULT_WORKERS, durationS: 0 };
  const include = card.querySelector("[data-source-include]")?.checked ?? true;
  const workersRaw = card.querySelector("[data-param=workers]")?.value?.trim();
  const durationRaw = card.querySelector("[data-param=duration]")?.value?.trim();
  let workers = DEFAULT_WORKERS;
  let durationS = 0;
  if (workersRaw) {
    const n = Number.parseInt(workersRaw, 10);
    if (Number.isFinite(n) && n > 0) workers = n;
  }
  if (durationRaw !== undefined && durationRaw !== "") {
    const n = Number.parseInt(durationRaw, 10);
    if (Number.isFinite(n) && n >= 0) durationS = n;
  }
  return { include, workers, durationS };
}

function collectWaveJobs(runs, makesCatalog) {
  const staleOnly = document.getElementById("crawl-stale-only")?.checked ?? false;
  const freshHours =
    Number.parseInt(document.getElementById("crawl-fresh-hours")?.value || "", 10) ||
    DEFAULT_FRESH_HOURS;
  const include = {};
  const perSourceWorkers = {};
  const perSourceDuration = {};
  for (const source of SOURCE_ORDER) {
    const p = readSourceParams(source);
    include[source] = p.include;
    perSourceWorkers[source] = p.workers;
    perSourceDuration[source] = p.durationS;
  }

  const baseJobs = planWaveJobs({
    runs,
    makesCatalog,
    staleOnly,
    freshHours,
    include,
    workers: DEFAULT_WORKERS,
    durationS: 0,
  });

  return baseJobs.map((job) => ({
    ...job,
    workers: perSourceWorkers[job.source] ?? job.workers,
    duration_s: perSourceDuration[job.source] ?? job.duration_s,
  }));
}

function refreshLaunchSummary(runs, makesCatalog) {
  const jobs = collectWaveJobs(runs, makesCatalog);
  const summary = document.getElementById("crawl-wave-summary");
  const launchBtn = document.getElementById("crawl-wave-launch");
  const n = jobs.length;
  const workers = jobs.reduce((acc, j) => acc + (j.workers || 1), 0);
  if (summary) {
    summary.textContent = n
      ? `${n} source${n === 1 ? "" : "s"} · ~${workers} workers · stale-first`
      : "Enable at least one source with stale keys";
  }
  if (launchBtn) launchBtn.disabled = n < 1;
}

function renderStaleKeyList(keys, { limit = 8 } = {}) {
  if (!keys?.length) return `<span class="crawl-stale-empty">All keys recently crawled</span>`;
  const shown = keys.slice(0, limit);
  const rest = keys.length - shown.length;
  return `<span class="crawl-stale-keys">${shown.map((k) => `<code>${escapeHtml(k)}</code>`).join(" ")}${
    rest > 0 ? ` <span class="crawl-stale-more">+${rest}</span>` : ""
  }</span>`;
}

function renderSourceSlide(source, staleInfo, lastRun) {
  const label = niceSource(source);
  const shard = SOURCE_SHARD_JOB[source];
  const lastWhen = lastRun?.finished_at || lastRun?.started_at;
  const lastLabel = lastRun
    ? `${formatWhen(lastWhen)} · ${escapeHtml(lastRun.status || "—")}`
    : "No crawl recorded";

  const stale = staleInfo?.keys_stale ?? 0;
  const total = staleInfo?.keys_total ?? 0;
  const never = staleInfo?.keys_never ?? 0;
  const staleKeys = staleInfo?.stale_keys || [];

  return `<article class="source-card crawl-source-card carousel-slide" data-crawl-source="${escapeHtml(source)}" id="crawl-source-${escapeHtml(source)}">
    <header class="source-card-head">
      <h3>${escapeHtml(label)}</h3>
      <label class="crawl-source-toggle">
        <input type="checkbox" data-source-include checked />
        Include
      </label>
    </header>
    <dl class="source-meta crawl-source-meta">
      <div><dt>Shard job</dt><dd><code>${escapeHtml(shard)}</code></dd></div>
      <div><dt>Last crawl</dt><dd>${lastLabel}</dd></div>
      <div><dt>Stale keys</dt><dd>${stale} / ${total} <span class="crawl-never">(${never} never)</span></dd></div>
      <div><dt>Stale-first queue</dt><dd>${renderStaleKeyList(staleKeys)}</dd></div>
    </dl>
    <div class="crawl-launch-params crawl-source-params">
      <label class="crawl-launch-field">Workers
        <input type="number" min="1" max="40" step="1" data-param="workers" value="${DEFAULT_WORKERS}" inputmode="numeric" />
      </label>
      <label class="crawl-launch-field">Duration (s)
        <input type="number" min="0" step="60" data-param="duration" value="0" inputmode="numeric" title="0 = until exhausted" />
      </label>
    </div>
  </article>`;
}

function renderSourcesCarousel(runs, makesCatalog, freshHours) {
  const summary = buildStaleSummary(runs, makesCatalog, freshHours);
  const tabs = SOURCE_ORDER.map(
    (id, idx) =>
      `<button type="button" class="carousel-tab${idx === 0 ? " is-active" : ""}" data-index="${idx}" role="tab" aria-selected="${
        idx === 0 ? "true" : "false"
      }" aria-controls="crawl-source-${escapeHtml(id)}">${escapeHtml(niceSource(id))}</button>`
  ).join("");
  const slides = SOURCE_ORDER.map((id) =>
    renderSourceSlide(id, summary.sources[id], lastSourceCrawl(runs, id))
  ).join("");
  const dots = SOURCE_ORDER.map(
    (_, idx) =>
      `<button type="button" class="carousel-dot${idx === 0 ? " is-active" : ""}" data-index="${idx}" aria-label="Source ${idx + 1}"></button>`
  ).join("");

  return `<div class="sources-carousel crawl-sources-carousel" data-slide-count="${SOURCE_ORDER.length}">
    <div class="carousel-toolbar">
      <div class="carousel-tabs" role="tablist">${tabs}</div>
      <div class="carousel-nav">
        <button type="button" class="btn ghost carousel-prev" aria-label="Previous source">←</button>
        <span class="carousel-counter">1 / ${SOURCE_ORDER.length}</span>
        <button type="button" class="btn ghost carousel-next" aria-label="Next source">→</button>
      </div>
    </div>
    <div class="carousel-viewport">
      <div class="carousel-track">${slides}</div>
    </div>
    <div class="carousel-dots" role="group" aria-label="Crawl source slides">${dots}</div>
  </div>`;
}

function initCrawlCarousel(root) {
  const carousel = root.querySelector(".crawl-sources-carousel");
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
  }

  tabs.forEach((tab) => tab.addEventListener("click", () => goTo(Number(tab.dataset.index))));
  dots.forEach((dot) => dot.addEventListener("click", () => goTo(Number(dot.dataset.index))));
  prevBtn?.addEventListener("click", () => goTo(current - 1));
  nextBtn?.addEventListener("click", () => goTo(current + 1));
  goTo(0);
}

function bindWebhookSettings() {
  const urlEl = document.getElementById("crawl-webhook-url");
  const tokenEl = document.getElementById("crawl-webhook-token");
  const ghEl = document.getElementById("crawl-github-token");
  const saveBtn = document.getElementById("crawl-webhook-save");
  const saved = loadWebhookSettings();
  if (urlEl && !urlEl.value) urlEl.value = saved.url;
  if (tokenEl && saved.token && !tokenEl.value) {
    tokenEl.placeholder = "Bearer token saved on this device";
  }
  if (ghEl && saved.ghToken && !ghEl.value) {
    ghEl.placeholder = "GitHub PAT saved on this device";
  }
  const details = document.getElementById("crawl-automation-settings");
  if (details && !saved.ghToken) details.open = true;
  if (saveBtn?.dataset.bound) return;
  if (saveBtn) saveBtn.dataset.bound = "1";
  saveBtn?.addEventListener("click", () => {
    const url = urlEl?.value?.trim() || saved.url;
    const token = tokenEl?.value?.trim() || loadWebhookSettings().token;
    const ghToken = ghEl?.value?.trim() || loadWebhookSettings().ghToken;
    if (!ghToken && !(url && token)) {
      setWaveStatus(
        "Need a listings-atlas- GitHub PAT (recommended) or webhook URL + Bearer.",
        { error: true }
      );
      return;
    }
    saveWebhookSettings({ url, token, ghToken });
    if (tokenEl && tokenEl.value) {
      tokenEl.value = "";
      tokenEl.placeholder = "Bearer token saved on this device";
    }
    if (ghEl && ghEl.value) {
      ghEl.value = "";
      ghEl.placeholder = "GitHub PAT saved on this device";
    }
    setWaveStatus("Credentials saved in this browser only.");
  });
  document.getElementById("crawl-filter-wave")?.addEventListener("change", () => {
    initCrawls();
  });
}

let currentRuns = [];
let currentMakes = {};

function bindLaunchPanel() {
  const launchBtn = document.getElementById("crawl-wave-launch");
  const board = document.getElementById("crawl-sources-board");
  if (launchBtn?.dataset.bound) return;
  if (launchBtn) launchBtn.dataset.bound = "1";

  board?.addEventListener("change", (e) => {
    if (
      e.target.matches("[data-source-include]") ||
      e.target.matches("[data-param=workers]") ||
      e.target.matches("[data-param=duration]")
    ) {
      refreshLaunchSummary(currentRuns, currentMakes);
    }
  });
  board?.addEventListener("input", (e) => {
    if (e.target.matches("[data-param=workers]") || e.target.matches("[data-param=duration]")) {
      refreshLaunchSummary(currentRuns, currentMakes);
    }
  });
  document.getElementById("crawl-stale-only")?.addEventListener("change", () => {
    renderLaunchBoard(currentRuns, currentMakes);
  });
  document.getElementById("crawl-fresh-hours")?.addEventListener("change", () => {
    renderLaunchBoard(currentRuns, currentMakes);
  });

  launchBtn?.addEventListener("click", async () => {
    const jobs = collectWaveJobs(currentRuns, currentMakes);
    if (!jobs.length) {
      setWaveStatus("Enable at least one source with keys to crawl.", { error: true });
      return;
    }
    const settings = loadWebhookSettings();
    const urlEl = document.getElementById("crawl-webhook-url");
    const tokenEl = document.getElementById("crawl-webhook-token");
    const ghEl = document.getElementById("crawl-github-token");
    const nameEl = document.getElementById("crawl-wave-name");
    const url = urlEl?.value?.trim() || settings.url;
    const token = tokenEl?.value?.trim() || settings.token;
    const ghToken = ghEl?.value?.trim() || settings.ghToken;
    if (!ghToken && !(url && token)) {
      document.getElementById("crawl-automation-settings")?.setAttribute("open", "");
      setWaveStatus(
        "Save a listings-atlas- GitHub PAT (Contents write), or webhook URL + Bearer.",
        { error: true }
      );
      return;
    }
    saveWebhookSettings({ url, token, ghToken });
    const payload = buildWavePayload({
      name: nameEl?.value?.trim() || "stale-first",
      jobs,
    });
    launchBtn.disabled = true;
    setWaveStatus(`Launching ${payload.wave_id}…`);
    try {
      const result = await postCrawlWave(payload, { url, token, ghToken });
      rememberWaveId(payload.wave_id);
      const via =
        result?.via === "github"
          ? "queued on GitHub (Action forwards to Cursor)"
          : "sent to Cursor webhook";
      setWaveStatus(`Wave ${payload.wave_id} ${via}. Tap Refresh in a minute.`);
    } catch (err) {
      setWaveStatus(err.message || String(err), { error: true });
    } finally {
      refreshLaunchSummary(currentRuns, currentMakes);
    }
  });
}

function renderLaunchBoard(runs, makesCatalog) {
  currentRuns = runs;
  currentMakes = makesCatalog;
  const root = document.getElementById("crawl-sources-board");
  if (!root) return;
  const freshHours =
    Number.parseInt(document.getElementById("crawl-fresh-hours")?.value || "", 10) ||
    DEFAULT_FRESH_HOURS;
  root.innerHTML = renderSourcesCarousel(runs, makesCatalog, freshHours);
  initCrawlCarousel(root);
  refreshLaunchSummary(runs, makesCatalog);
}

const LIVE_STATUS_URLS = [
  "data/crawl_status.json",
  "https://raw.githubusercontent.com/CrangoOne/listings-atlas-/main/data/crawl_status.json",
];
const LIVE_JOBS_URLS = [
  "data/crawl_jobs.json",
  "https://raw.githubusercontent.com/CrangoOne/listings-atlas-/main/data/crawl_jobs.json",
];

function withCacheBust(url) {
  const sep = url.includes("?") ? "&" : "?";
  return `${url}${sep}t=${Date.now()}&r=${Math.random().toString(36).slice(2, 8)}`;
}

function parseUpdatedAt(data) {
  const raw = data?.updated_at;
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

async function fetchJsonPreferLive(liveUrls) {
  const results = await Promise.allSettled(liveUrls.map((u) => fetchOneJson(u)));
  const ok = results
    .filter((r) => r.status === "fulfilled")
    .map((r) => r.value)
    .filter((v) => v?.data && typeof v.data === "object");
  if (!ok.length) {
    const last = results.find((r) => r.status === "rejected");
    throw last?.reason || new Error("Could not load JSON");
  }
  ok.sort((a, b) => parseUpdatedAt(b.data) - parseUpdatedAt(a.data));
  return ok[0];
}

export async function initCrawls() {
  const meta = document.getElementById("crawl-board-meta");
  bindWebhookSettings();
  bindLaunchPanel();
  try {
    const [statusPack, jobsPack] = await Promise.all([
      fetchJsonPreferLive(LIVE_STATUS_URLS),
      fetchJsonPreferLive(LIVE_JOBS_URLS).catch(() => null),
    ]);
    const status = statusPack.data;
    let runs = Array.isArray(status.runs) ? status.runs : [];
    const totalRuns = runs.length;
    const waveFilter = lastWaveId();
    const onlyWave = document.getElementById("crawl-filter-wave")?.checked;
    if (onlyWave && waveFilter) {
      runs = runs.filter((r) => r.wave_id === waveFilter);
    }
    renderCrawlKpis(runs, status.updated_at);
    renderRunsTable(runs);

    const makesCatalog = jobsPack?.data?.makes || {};
    renderLaunchBoard(runs, makesCatalog);

    const filterHint = document.getElementById("crawl-wave-filter-label");
    if (filterHint) {
      filterHint.hidden = !waveFilter;
      const label = document.getElementById("crawl-filter-wave-text");
      if (label) label.textContent = waveFilter ? `Only ${waveFilter}` : "";
    }
    if (meta) {
      let source = "live";
      if (statusPack.url.includes("raw.githubusercontent.com")) source = "live raw";
      else if (statusPack.url.includes("data/crawl_status")) source = "live pages";
      const when = status.updated_at ? formatWhen(status.updated_at) : "—";
      const filterNote =
        onlyWave && waveFilter ? ` · filtered ${runs.length}/${totalRuns}` : "";
      meta.textContent = totalRuns
        ? `${totalRuns} run(s)${filterNote} · updated ${when} · ${source} · times ${TZ_HINT} · UI ${ASSET_BUILD}`
        : `Compose a stale-first wave above, Launch, then Refresh. · times ${TZ_HINT} · UI ${ASSET_BUILD}`;
    }
  } catch (err) {
    renderCrawlKpis([], null);
    renderRunsTable([]);
    if (meta) meta.textContent = `Could not load crawl board: ${err.message}`;
    console.error(err);
  }
}

let crawlsRefreshTimer = null;
export function startCrawlsAutoRefresh(intervalMs = 30000) {
  if (crawlsRefreshTimer) return;
  crawlsRefreshTimer = window.setInterval(() => {
    const section = document.getElementById("crawls");
    if (!section) return;
    const rect = section.getBoundingClientRect();
    const visible = rect.bottom > 0 && rect.top < window.innerHeight;
    if (visible) initCrawls();
  }, intervalMs);
}
