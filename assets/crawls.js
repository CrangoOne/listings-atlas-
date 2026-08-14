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

function renderJobCatalog(jobs) {
  const root = document.getElementById("crawl-jobs");
  if (!root) return;
  if (!jobs?.length) {
    root.innerHTML = `<p class="crawl-hint">Job catalog not loaded.</p>`;
    return;
  }
  root.innerHTML = jobs
    .map(
      (j) => `<article class="crawl-job-row">
        <div class="crawl-job-id"><code>${escapeHtml(j.id)}</code></div>
        <div class="crawl-job-copy">
          <strong>${escapeHtml(niceSource(j.source))}</strong>
          <span>${escapeHtml(j.summary || "")}</span>
        </div>
        <div class="crawl-job-meta">
          <span>${escapeHtml(j.workers || "—")} worker(s)</span>
          <span>${escapeHtml(j.duration_default || "—")}</span>
        </div>
      </article>`
    )
    .join("");
}

export async function initCrawls() {
  const meta = document.getElementById("crawl-board-meta");
  try {
    const [statusRes, jobsRes] = await Promise.all([
      fetch("data/crawl_status.json", { cache: "no-cache" }),
      fetch("data/crawl_jobs.json", { cache: "no-cache" }),
    ]);
    if (!statusRes.ok) throw new Error(`crawl_status.json (${statusRes.status})`);
    const status = await statusRes.json();
    const runs = Array.isArray(status.runs) ? status.runs : [];
    renderCrawlKpis(runs, status.updated_at);
    renderRunsTable(runs);
    if (meta) {
      meta.textContent = runs.length
        ? `${runs.length} run(s) in crawl_status.json`
        : "Board is empty — launch a catalog job, then workers append rows here.";
    }
    if (jobsRes.ok) {
      const jobsPayload = await jobsRes.json();
      renderJobCatalog(jobsPayload.jobs || []);
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
