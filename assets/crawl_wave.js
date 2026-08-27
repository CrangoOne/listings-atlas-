const LS_URL = "listings-atlas.crawlWebhookUrl";
const LS_TOKEN = "listings-atlas.crawlWebhookToken";
const LS_GH = "listings-atlas.githubToken";
const LS_LAST_WAVE = "listings-atlas.lastWaveId";

const GH_REPO = "CrangoOne/listings-atlas-";
const GH_WAVE_PATH = "data/pending_wave.json";

export function loadWebhookSettings() {
  return {
    url: (localStorage.getItem(LS_URL) || "").trim(),
    token: (localStorage.getItem(LS_TOKEN) || "").trim(),
    ghToken: (localStorage.getItem(LS_GH) || "").trim(),
  };
}

export function saveWebhookSettings({ url, token, ghToken }) {
  if (url != null) localStorage.setItem(LS_URL, String(url).trim());
  if (token != null) localStorage.setItem(LS_TOKEN, String(token).trim());
  if (ghToken != null) localStorage.setItem(LS_GH, String(ghToken).trim());
}

export function lastWaveId() {
  return localStorage.getItem(LS_LAST_WAVE) || "";
}

export function rememberWaveId(id) {
  if (id) localStorage.setItem(LS_LAST_WAVE, id);
}

export function newWaveId(name) {
  const stamp = new Date()
    .toISOString()
    .replace(/[-:]/g, "")
    .replace(/\.\d+Z$/, "Z")
    .toLowerCase();
  const slug = String(name || "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 24);
  const rand = Math.random().toString(36).slice(2, 6);
  return slug ? `wave-${slug}-${stamp.slice(0, 8)}-${rand}` : `wave-${stamp}-${rand}`;
}

export function jobFlags(job) {
  const parts = [];
  if (job.workers != null) parts.push(`--workers ${job.workers}`);
  if (job.duration_s != null) parts.push(`--duration ${job.duration_s}`);
  if (job.makes) parts.push(`--makes ${job.makes}`);
  return parts.join(" ");
}

export function buildDispatcherPrompt(payload) {
  const lines = [
    `Launch Listings Atlas crawl wave \`${payload.wave_id}\`.`,
    "You are the crawl-wave dispatcher. Follow daq/jobs/WAVE_AUTOMATION.md and the launch-crawl skill.",
    "Do not ask for confirmation.",
  ];
  if (payload.name) lines.push(`Wave name: ${payload.name}.`);
  lines.push("Jobs:");
  for (const j of payload.jobs) {
    const extra = jobFlags(j);
    lines.push(`- \`${j.job_id}\`${extra ? ` ${extra}` : ""}`);
    if (j.stale_first && j.makes) {
      lines.push(`  (stale-first shard keys — keep \`--makes\` order as sent)`);
    }
  }
  lines.push(
    "Before spawning: save webhook JSON to /tmp/wave.json, run " +
      "`python3 daq/jobs/wave_spawn_gap.py --wave-file /tmp/wave.json --board docs/data/crawl_status.json --stamp-queued` " +
      "so all expected workers appear as queued on the board."
  );
  lines.push(
    `For each job run \`python3 daq/jobs/launch_crawl.py prompt <job_id> ${payload.jobs.length ? "[flags]" : ""} --wave-id ${payload.wave_id} --json\`. ` +
      "Spawn one cloud worker per returned prompt (or only \`spawn_only\` ids on retry). " +
      "Stamp running only with --agent-url. Loop \`wave_spawn_gap.py --json\` until gap_count is 0 " +
      "(retry up to 10 rounds; scheduled Action retries every 15 min if needed)."
  );
  return lines.join("\n");
}

export function buildWavePayload({ name, jobs }) {
  const wave_id = newWaveId(name);
  const requested_at = new Date().toISOString().replace(/\.\d{3}Z$/, "Z");
  const payload = {
    kind: "listings-atlas-crawl-wave",
    wave_id,
    name: name || null,
    requested_at,
    jobs,
  };
  const prompt = buildDispatcherPrompt(payload);
  payload.prompt = prompt;
  payload.text = prompt;
  return payload;
}

function looksLikeWebhookUrl(url) {
  try {
    const u = new URL(url);
    return (
      /cursor\.(com|sh)$/i.test(u.hostname) ||
      u.pathname.includes("automations/webhook")
    );
  } catch {
    return false;
  }
}

function utf8ToBase64(text) {
  const bytes = new TextEncoder().encode(text);
  let bin = "";
  bytes.forEach((b) => {
    bin += String.fromCharCode(b);
  });
  return btoa(bin);
}

function ghHeaders(ghToken) {
  const auth = ghToken.toLowerCase().startsWith("bearer ")
    ? ghToken
    : `Bearer ${ghToken}`;
  return {
    Authorization: auth,
    Accept: "application/vnd.github+json",
    "X-GitHub-Api-Version": "2022-11-28",
    "Content-Type": "application/json",
  };
}

/** Queue the wave via GitHub Contents API (CORS-ok from Pages). */
export async function queueWaveOnGitHub(payload, ghToken) {
  if (!ghToken) throw new Error("Save a GitHub token with Contents write on listings-atlas-.");
  const api = `https://api.github.com/repos/${GH_REPO}/contents/${GH_WAVE_PATH}`;
  const headers = ghHeaders(ghToken);
  let sha;
  const getRes = await fetch(api, { headers, cache: "no-store" });
  if (getRes.ok) {
    const current = await getRes.json();
    sha = current.sha;
  } else if (getRes.status !== 404) {
    const t = await getRes.text();
    throw new Error(`GitHub GET pending_wave ${getRes.status}: ${t.slice(0, 200)}`);
  }
  const body = {
    message: `chore(crawl): queue ${payload.wave_id}`,
    content: utf8ToBase64(`${JSON.stringify(payload, null, 2)}\n`),
    branch: "main",
  };
  if (sha) body.sha = sha;
  const putRes = await fetch(api, {
    method: "PUT",
    headers,
    body: JSON.stringify(body),
  });
  const text = await putRes.text();
  if (!putRes.ok) {
    throw new Error(`GitHub queue ${putRes.status}: ${text.slice(0, 240)}`);
  }
  return { status: putRes.status, via: "github" };
}

export async function postCrawlWaveDirect(payload, { url, token }) {
  if (!url) throw new Error("Save the automation webhook URL first.");
  if (!token) throw new Error("Save the automation Bearer token first.");
  if (!looksLikeWebhookUrl(url)) {
    throw new Error(
      "Webhook URL should be the Cursor automation endpoint (cursor.com / cursor.sh)."
    );
  }
  const headers = {
    Authorization: token.toLowerCase().startsWith("bearer ")
      ? token
      : `Bearer ${token}`,
    "Content-Type": "application/json",
    Accept: "application/json",
  };
  const res = await fetch(url, {
    method: "POST",
    headers,
    body: JSON.stringify(payload),
    mode: "cors",
  });
  const bodyText = await res.text();
  let body = bodyText;
  try {
    body = bodyText ? JSON.parse(bodyText) : {};
  } catch {
    /* keep text */
  }
  if (!res.ok) {
    const detail =
      (body && (body.message || body.error || body.detail)) ||
      bodyText.slice(0, 280) ||
      res.statusText;
    throw new Error(`Webhook ${res.status}: ${detail}`);
  }
  return { status: res.status, body, via: "webhook" };
}

/**
 * Phone/Pages cannot POST to Cursor webhooks (no Access-Control-Allow-Origin).
 * Prefer GitHub queue; fall back to direct webhook.
 */
export async function postCrawlWave(payload, settings) {
  const { url, token, ghToken } = settings;
  if (ghToken) {
    return queueWaveOnGitHub(payload, ghToken);
  }
  try {
    return await postCrawlWaveDirect(payload, { url, token });
  } catch (err) {
    const msg = err?.message || String(err);
    if (/failed to fetch|networkerror|cors/i.test(msg)) {
      throw new Error(
        "Launch failed: GitHub Pages cannot call the Cursor webhook (browser CORS). " +
          "Paste your listings-atlas- GitHub PAT (Contents: Read and write) in settings, " +
          "and add repo secrets CRAWL_WAVE_WEBHOOK_URL + CRAWL_WAVE_WEBHOOK_BEARER, then Launch again."
      );
    }
    throw new Error(msg.startsWith("Launch failed") ? msg : `Launch failed: ${msg}`);
  }
}
