import {
  loadWebhookSettings,
  saveWebhookSettings,
  lastWaveId,
  rememberWaveId,
  buildWavePayload,
  postCrawlWave,
} from "./crawl_wave.js?v=20260821b";

/** Bumped whenever status-fetch logic changes — shown in board meta so stale caches are obvious. */
const ASSET_BUILD = "20260821b";

const SOURCE_LABEL = {
  willhaben: "Willhaben",
  autoscout: "AutoScout24",
  kleinanzeigen: "Kleinanzeigen",
  coches: "coches.net",
  wko: "WKO",
};

const STATUS_ORDER = ["running", "queued", "failed", "finished", "cancelled"];

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
  if (Number.isNaN(d.getTime())) return escapeHtml(iso);
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

function countByStatus(runs) {
  const out = { running: 0, queued: 0, finished: 0, failed: 0, cancelled: 0 };
  for (const r of runs) {
    const s = r.status || "queued";
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
    { label: "Runs", value: String(runs.length), sub: updatedAt ? `Updated ${formatWhen(updatedAt)}` : "No status yet" },
    { label: "Running", value: String(counts.running), sub: "live workers" },
    { label: "Queued", value: String(counts.queued), sub: "waiting / pending" },
    { label: "Finished", value: String(counts.finished), sub: `${counts.failed} failed` },
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

function sortRuns(runs) {
  return [...runs].sort((a, b) => {
    const sa = STATUS_ORDER.indexOf(a.status);
    const sb = STATUS_ORDER.indexOf(b.status);
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
      return `<tr>
        <td><span class="crawl-status crawl-status--${escapeHtml(r.status || "queued")}">${escapeHtml(r.status || "queued")}</span></td>
        <td>
          <div class="crawl-job">${escapeHtml(r.job_id || "—")}</div>
          <div class="crawl-meta">${escapeHtml(r.worker_id || "")}${
            r.wave_id ? ` · ${escapeHtml(r.wave_id)}` : ""
          }</div>
        </td>
        <td>${escapeHtml(niceSource(r.source))}</td>
        <td class="crawl-makes" title="${escapeHtml(makes)}">${escapeHtml(makes)}</td>
        <td>${formatWhen(r.started_at)}</td>
        <td>${formatWhen(r.finished_at)}</td>
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

function readJobParams(article) {
  const workersEl = article.querySelector("[data-param=workers]");
  const durationEl = article.querySelector("[data-param=duration]");
  const makesEl = article.querySelector("[data-param=makes]");
  const workersRaw = workersEl?.value?.trim();
  const durationRaw = durationEl?.value?.trim();
  const makes = makesEl?.value?.trim() || "";
  let workers = null;
  let durationS = null;
  if (workersRaw) {
    const n = Number.parseInt(workersRaw, 10);
    if (Number.isFinite(n) && n > 0) workers = n;
  }
  if (durationRaw !== undefined && durationRaw !== "" && durationEl) {
    const n = Number.parseInt(durationRaw, 10);
    if (Number.isFinite(n) && n >= 0) durationS = n;
  }
  return { workers, durationS, makes };
}

function collectSelectedJobs(jobsById) {
  const root = document.getElementById("crawl-jobs");
  if (!root) return [];
  const selected = [];
  root.querySelectorAll("[data-job-id]").forEach((article) => {
    const box = article.querySelector("[data-wave-include]");
    if (!box?.checked) return;
    const job = jobsById.get(article.getAttribute("data-job-id"));
    if (!job) return;
    const { workers, durationS, makes } = readJobParams(article);
    const entry = { job_id: job.id, source: job.source || null };
    if (job.supports?.workers && workers != null) entry.workers = workers;
    if (job.supports?.duration && durationS != null) entry.duration_s = durationS;
    if (job.supports?.makes && makes) entry.makes = makes;
    selected.push(entry);
  });
  return selected;
}

function setWaveStatus(message, { error = false } = {}) {
  const el = document.getElementById("crawl-wave-status");
  if (!el) return;
  el.hidden = !message;
  el.textContent = message || "";
  el.classList.toggle("crawl-wave-status--error", Boolean(error));
}

function refreshWaveSummary(jobsById) {
  const n = collectSelectedJobs(jobsById).length;
  const summary = document.getElementById("crawl-wave-summary");
  const launchBtn = document.getElementById("crawl-wave-launch");
  if (summary) {
    summary.textContent = n
      ? `${n} job${n === 1 ? "" : "s"} in this wave`
      : "Select jobs below, then Launch wave";
  }
  if (launchBtn) launchBtn.disabled = n < 1;
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
  const filter = document.getElementById("crawl-filter-wave");
  filter?.addEventListener("change", () => {
    initCrawls();
  });
}

let currentJobsById = new Map();

function bindWaveComposer(jobsById) {
  currentJobsById = jobsById;
  const root = document.getElementById("crawl-jobs");
  const launchBtn = document.getElementById("crawl-wave-launch");
  root?.querySelectorAll("[data-wave-include]").forEach((box) => {
    box.addEventListener("change", () => refreshWaveSummary(currentJobsById));
  });
  refreshWaveSummary(currentJobsById);
  if (launchBtn?.dataset.bound) return;
  if (launchBtn) launchBtn.dataset.bound = "1";

  launchBtn?.addEventListener("click", async () => {
    const jobs = collectSelectedJobs(currentJobsById);
    if (!jobs.length) {
      setWaveStatus("Select at least one job.", { error: true });
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
      name: nameEl?.value?.trim() || "",
      jobs,
    });
    launchBtn.disabled = true;
    setWaveStatus(`Launching ${payload.wave_id}…`);
    try {
      const result = await postCrawlWave(payload, { url, token, ghToken });
      rememberWaveId(payload.wave_id);
      const via = result?.via === "github" ? "queued on GitHub (Action forwards to Cursor)" : "sent to Cursor webhook";
      setWaveStatus(
        `Wave ${payload.wave_id} ${via}. Tap Refresh in a minute.`
      );
    } catch (err) {
      setWaveStatus(err.message || String(err), { error: true });
    } finally {
      refreshWaveSummary(currentJobsById);
    }
  });
}

function paramFields(job) {
  const supports = job.supports || {};
  const defaults = job.defaults || {};
  const fields = [];
  if (supports.workers) {
    const v = defaults.workers != null ? String(defaults.workers) : "5";
    fields.push(`<label class="crawl-launch-field">Workers
      <input type="number" min="1" max="40" step="1" data-param="workers" value="${escapeHtml(v)}" inputmode="numeric" />
    </label>`);
  }
  if (supports.duration) {
    const v = defaults.duration_s != null ? String(defaults.duration_s) : "0";
    fields.push(`<label class="crawl-launch-field">Duration (s)
      <input type="number" min="0" step="60" data-param="duration" value="${escapeHtml(v)}" inputmode="numeric" title="0 = until exhausted" />
    </label>`);
  }
  if (supports.makes) {
    const sample = Array.isArray(job.makes_sample) ? job.makes_sample.join(",") : "";
    fields.push(`<label class="crawl-launch-field crawl-launch-field--makes">Makes
      <input type="text" data-param="makes" placeholder="${escapeHtml(sample || "bmw,audi,…")}" spellcheck="false" autocomplete="off" />
    </label>`);
  }
  if (!fields.length) return "";
  return `<div class="crawl-launch-params">${fields.join("")}</div>`;
}

function renderJobCatalog(jobs) {
  const root = document.getElementById("crawl-jobs");
  if (!root) return;
  if (!jobs?.length) {
    root.innerHTML = `<p class="crawl-hint">Job catalog not loaded.</p>`;
    return;
  }
  const jobsById = new Map(jobs.map((j) => [j.id, j]));
  root.innerHTML = jobs
    .map(
      (j) => `<article class="crawl-job-row" data-job-id="${escapeHtml(j.id)}">
        <label class="crawl-job-check">
          <input type="checkbox" data-wave-include />
          <code>${escapeHtml(j.id)}</code>
        </label>
        <div class="crawl-job-copy">
          <strong>${escapeHtml(niceSource(j.source))}</strong>
          <span>${escapeHtml(j.summary || "")}</span>
          <div class="crawl-job-meta-inline">
            <span>${escapeHtml(j.workers || "—")} worker(s)</span>
            <span>·</span>
            <span>${escapeHtml(j.duration_default || "—")}</span>
          </div>
          ${paramFields(j)}
        </div>
      </article>`
    )
    .join("");
  bindWaveComposer(jobsById);
}

/**
 * Live board sources (newest first).
 *
 * Never use jsDelivr / long-lived CDNs for crawl_status — they can stay stale
 * for hours/days while workers update the board. Prefer same-origin Pages
 * (cache-busted) then raw.githubusercontent.
 */
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

/**
 * Fetch all candidates and keep the freshest board by updated_at.
 * This avoids silently sticking to a stale first success.
 */
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
        ? `${totalRuns} run(s)${filterNote} · updated ${when} · ${source} · UI ${ASSET_BUILD}`
        : `Board is empty — compose a wave above, Launch, then Refresh. · UI ${ASSET_BUILD}`;
    }
    if (jobsPack?.data) {
      renderJobCatalog(jobsPack.data.jobs || []);
    } else {
      renderJobCatalog([]);
    }
  } catch (err) {
    renderCrawlKpis([], null);
    renderRunsTable([]);
    if (meta) meta.textContent = `Could not load crawl board: ${err.message}`;
    console.error(err);
  }
}

/** Auto-refresh the board while the Crawls section is visible. */
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
