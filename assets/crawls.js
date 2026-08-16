const SOURCE_LABEL = {
  willhaben: "Willhaben",
  autoscout: "AutoScout24",
  kleinanzeigen: "Kleinanzeigen",
  coches: "coches.net",
  wko: "WKO",
};

const STATUS_ORDER = ["running", "queued", "failed", "finished", "cancelled"];

const PROMPT_DEEPLINK = "https://cursor.com/link/prompt";

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
  if (Number.isNaN(d.getTime())) return escapeHtml(iso);
  return d.toLocaleString(undefined, {
    year: "numeric",
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
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
          <div class="crawl-meta">${escapeHtml(r.worker_id || "")}</div>
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

/** Short coordinator prompt — opens Cursor chat; agent expands via launch-crawl skill. */
function buildLaunchPrompt(job, { workers, durationS, makes }) {
  const parts = [
    `Launch the DAQ crawl job \`${job.id}\` using the launch-crawl skill in this repo.`,
  ];
  if (workers != null) parts.push(`Use ${workers} workers.`);
  if (makes) parts.push(`Only these makes: ${makes}.`);
  if (durationS === 0) {
    parts.push("Full scrape (duration 0 — run until exhausted).");
  } else if (durationS != null) {
    parts.push(`Time cap: ${durationS} seconds.`);
  } else {
    parts.push("Use the catalog defaults for duration.");
  }
  parts.push(
    "Resolve with `python3 daq/jobs/launch_crawl.py prompt … --json`, spawn one cloud worker per shard, update `docs/data/crawl_status.json`, and publish with `python3 daq/jobs/publish_crawl_status.py`."
  );
  return parts.join(" ");
}

function promptDeeplink(text) {
  const url = new URL(PROMPT_DEEPLINK);
  url.searchParams.set("text", text);
  return url.toString();
}

function flashButton(btn, label) {
  const prev = btn.textContent;
  btn.textContent = label;
  btn.disabled = true;
  window.setTimeout(() => {
    btn.textContent = prev;
    btn.disabled = false;
  }, 1400);
}

function bindJobLaunch(root, jobsById) {
  root.querySelectorAll("[data-job-id]").forEach((article) => {
    const jobId = article.getAttribute("data-job-id");
    const job = jobsById.get(jobId);
    if (!job) return;
    const launchBtn = article.querySelector("[data-action=launch]");
    const copyBtn = article.querySelector("[data-action=copy]");
    const preview = article.querySelector("[data-prompt-preview]");

    const refreshPreview = () => {
      const prompt = buildLaunchPrompt(job, readJobParams(article));
      if (preview) preview.textContent = prompt;
      if (launchBtn) {
        const href = promptDeeplink(prompt);
        if (href.length > 7800) {
          launchBtn.setAttribute("aria-disabled", "true");
          launchBtn.removeAttribute("href");
          launchBtn.title =
            "Prompt too long for a deeplink — narrow makes or use Copy prompt";
        } else {
          launchBtn.removeAttribute("aria-disabled");
          launchBtn.href = href;
          launchBtn.title = "Open Cursor with this launch prompt";
        }
      }
      return prompt;
    };

    article.querySelectorAll("[data-param]").forEach((el) => {
      el.addEventListener("input", refreshPreview);
      el.addEventListener("change", refreshPreview);
    });
    refreshPreview();

    launchBtn?.addEventListener("click", (ev) => {
      if (!launchBtn.getAttribute("href")) {
        ev.preventDefault();
        window.alert(
          "Prompt is too long for a Cursor deeplink. Narrow the makes list, then try again — or use Copy prompt."
        );
      }
    });

    copyBtn?.addEventListener("click", async () => {
      const prompt = refreshPreview();
      try {
        await navigator.clipboard.writeText(prompt);
        flashButton(copyBtn, "Copied");
      } catch {
        window.prompt("Copy this launch prompt:", prompt);
      }
    });
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
        <div class="crawl-job-id"><code>${escapeHtml(j.id)}</code></div>
        <div class="crawl-job-copy">
          <strong>${escapeHtml(niceSource(j.source))}</strong>
          <span>${escapeHtml(j.summary || "")}</span>
          <div class="crawl-job-meta-inline">
            <span>${escapeHtml(j.workers || "—")} worker(s)</span>
            <span>·</span>
            <span>${escapeHtml(j.duration_default || "—")}</span>
          </div>
          ${paramFields(j)}
          <p class="crawl-prompt-preview" data-prompt-preview></p>
        </div>
        <div class="crawl-job-actions">
          <a class="btn" data-action="launch" target="_blank" rel="noopener noreferrer">Launch in Cursor</a>
          <button type="button" class="btn ghost" data-action="copy">Copy prompt</button>
        </div>
      </article>`
    )
    .join("");
  bindJobLaunch(root, jobsById);
}

/** Live board on the public Pages repo — agents push this file; no site-pack redeploy. */
const LIVE_STATUS_URL =
  "https://raw.githubusercontent.com/CrangoOne/listings-atlas-/main/data/crawl_status.json";
const LIVE_JOBS_URL =
  "https://raw.githubusercontent.com/CrangoOne/listings-atlas-/main/data/crawl_jobs.json";

async function fetchJsonPreferLive(liveUrl, localUrl) {
  const bust = `t=${Date.now()}`;
  const candidates = [
    `${liveUrl}${liveUrl.includes("?") ? "&" : "?"}${bust}`,
    `${localUrl}${localUrl.includes("?") ? "&" : "?"}${bust}`,
  ];
  let lastErr = null;
  for (const url of candidates) {
    try {
      const res = await fetch(url, { cache: "no-store" });
      if (!res.ok) {
        lastErr = new Error(`${url} (${res.status})`);
        continue;
      }
      return { data: await res.json(), url };
    } catch (err) {
      lastErr = err;
    }
  }
  throw lastErr || new Error("Could not load JSON");
}

export async function initCrawls() {
  const meta = document.getElementById("crawl-board-meta");
  try {
    const [statusPack, jobsPack] = await Promise.all([
      fetchJsonPreferLive(LIVE_STATUS_URL, "data/crawl_status.json"),
      fetchJsonPreferLive(LIVE_JOBS_URL, "data/crawl_jobs.json").catch(() => null),
    ]);
    const status = statusPack.data;
    const runs = Array.isArray(status.runs) ? status.runs : [];
    renderCrawlKpis(runs, status.updated_at);
    renderRunsTable(runs);
    if (meta) {
      const source = statusPack.url.includes("raw.githubusercontent.com")
        ? "live listings-atlas-"
        : "local data/";
      meta.textContent = runs.length
        ? `${runs.length} run(s) · ${source}`
        : "Board is empty — launch a catalog job below, then publish crawl_status.json.";
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
