/** Stale-first shard key ranking (mirrors daq/jobs/plan_stale_wave.py). */

export const SOURCE_ORDER = ["willhaben", "autoscout", "kleinanzeigen", "coches"];

export const SOURCE_SHARD_JOB = {
  willhaben: "willhaben_shard",
  autoscout: "autoscout_shard",
  kleinanzeigen: "ka_shard",
  coches: "coches_shard",
};

export const SOURCE_MAKES_KEY = {
  willhaben: "willhaben_makes",
  autoscout: "autoscout_makes",
  kleinanzeigen: "kleinanzeigen_makes",
  coches: "coches_years",
};

export const SOURCE_LABEL = {
  willhaben: "Willhaben",
  autoscout: "AutoScout24",
  kleinanzeigen: "Kleinanzeigen",
  coches: "coches.net",
};

function parseTs(raw) {
  if (!raw) return null;
  const ms = Date.parse(String(raw));
  return Number.isFinite(ms) ? ms : null;
}

function workerSuffix(workerId, jobId) {
  const wid = String(workerId || "").trim();
  const jid = String(jobId || "").trim();
  if (!wid || !jid || !wid.startsWith(`${jid}-`)) return null;
  return wid.slice(jid.length + 1) || null;
}

function keysFromRun(run, known) {
  const makes = run?.makes;
  if (Array.isArray(makes) && makes.length) {
    return makes.map((m) => String(m).trim()).filter(Boolean);
  }
  const suffix = workerSuffix(run?.worker_id, run?.job_id);
  if (!suffix) return [];
  if (known.has(suffix)) return [suffix];
  const alt = suffix.replace(/_/g, "-");
  if (known.has(alt)) return [alt];
  return [];
}

function mergeTouch(touches, key, run) {
  const status = String(run?.status || "");
  const finished = parseTs(run?.finished_at);
  const started = parseTs(run?.started_at);
  const prev = touches.get(key);
  if (!prev) {
    touches.set(key, {
      last_finished_at: finished,
      last_started_at: started,
      last_status: status,
      run_count: 1,
    });
    return;
  }
  prev.run_count += 1;
  if (finished != null && (prev.last_finished_at == null || finished > prev.last_finished_at)) {
    prev.last_finished_at = finished;
    prev.last_status = status;
  }
  if (started != null && (prev.last_started_at == null || started > prev.last_started_at)) {
    prev.last_started_at = started;
  }
}

export function buildSourceFreshness(runs, source, catalogKeys) {
  const keys = [...(catalogKeys || [])];
  const known = new Set(keys);
  const touches = new Map();

  for (const run of runs) {
    if (String(run?.source || "") !== source) continue;
    for (const key of keysFromRun(run, known)) {
      if (!known.has(key)) continue;
      mergeTouch(touches, key, run);
    }
  }

  const freshness = keys.map((key) => {
    const t = touches.get(key) || {};
    const runCount = t.run_count || 0;
    const lastFinished = t.last_finished_at ?? null;
    const lastStarted = t.last_started_at ?? null;
    const ref = lastFinished ?? lastStarted;
    const never = runCount === 0;
    return {
      key,
      never_touched: never,
      last_finished_at: lastFinished != null ? new Date(lastFinished).toISOString() : null,
      last_started_at: lastStarted != null ? new Date(lastStarted).toISOString() : null,
      last_status: t.last_status || null,
      run_count: runCount,
      reference_ms: ref,
      stale_sort: never ? 0 : ref ?? 0,
    };
  });

  freshness.sort((a, b) => {
    if (a.never_touched !== b.never_touched) return a.never_touched ? -1 : 1;
    return (a.stale_sort || 0) - (b.stale_sort || 0);
  });
  return freshness;
}

export function isKeyStale(entry, freshHours) {
  if (entry.never_touched) return true;
  const ref = entry.reference_ms;
  if (ref == null) return true;
  return Date.now() - ref >= freshHours * 3600 * 1000;
}

export function buildStaleSummary(runs, makesCatalog, freshHours = 168) {
  const sources = {};
  for (const source of SOURCE_ORDER) {
    const mk = SOURCE_MAKES_KEY[source];
    const catalogKeys = makesCatalog?.[mk] || [];
    const freshness = buildSourceFreshness(runs, source, catalogKeys);
    const stale = freshness.filter((f) => isKeyStale(f, freshHours));
    sources[source] = {
      shard_job: SOURCE_SHARD_JOB[source],
      keys_total: catalogKeys.length,
      keys_stale: stale.length,
      keys_never: freshness.filter((f) => f.never_touched).length,
      stale_keys: stale.map((f) => f.key),
      ordered_keys: freshness.map((f) => f.key),
      freshness,
    };
  }
  return { fresh_hours: freshHours, sources };
}

export function planWaveJobs({
  runs,
  makesCatalog,
  sources = SOURCE_ORDER,
  workers = 5,
  durationS = 0,
  staleOnly = false,
  freshHours = 168,
  include = null,
}) {
  const summary = buildStaleSummary(runs, makesCatalog, freshHours);
  const jobs = [];
  for (const source of sources) {
    if (include && include[source] === false) continue;
    const s = summary.sources[source];
    if (!s) continue;
    let keys = s.ordered_keys;
    if (staleOnly) {
      keys = s.freshness.filter((f) => isKeyStale(f, freshHours)).map((f) => f.key);
    }
    if (!keys.length) continue;
    jobs.push({
      job_id: s.shard_job,
      source,
      workers,
      duration_s: durationS,
      makes: keys.join(","),
      stale_first: true,
      stale_only: staleOnly,
    });
  }
  return jobs;
}

export function lastSourceCrawl(runs, source) {
  let best = null;
  let bestScore = [-1, 0];
  for (const run of runs) {
    if (String(run?.source || "") !== source) continue;
    const status = run?.status || "";
    const rank = status === "finished" ? 2 : status === "running" ? 1 : 0;
    const ts = parseTs(run?.finished_at) || parseTs(run?.started_at) || 0;
    const score = [rank, ts];
    if (score[0] > bestScore[0] || (score[0] === bestScore[0] && score[1] > bestScore[1])) {
      best = run;
      bestScore = score;
    }
  }
  return best;
}
