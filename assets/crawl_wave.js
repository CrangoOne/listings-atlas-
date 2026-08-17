const LS_URL = "listings-atlas.crawlWebhookUrl";
const LS_TOKEN = "listings-atlas.crawlWebhookToken";
const LS_LAST_WAVE = "listings-atlas.lastWaveId";

export function loadWebhookSettings() {
  return {
    url: (localStorage.getItem(LS_URL) || "").trim(),
    token: (localStorage.getItem(LS_TOKEN) || "").trim(),
  };
}

export function saveWebhookSettings({ url, token }) {
  localStorage.setItem(LS_URL, (url || "").trim());
  localStorage.setItem(LS_TOKEN, (token || "").trim());
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
  }
  lines.push(
    `For each job run \`python3 daq/jobs/launch_crawl.py prompt <job_id> ${payload.jobs.length ? "[flags]" : ""} --wave-id ${payload.wave_id} --json\`, spawn one cloud worker per returned prompt, stamp wave_id on docs/data/crawl_status.json, and publish with python3 daq/jobs/publish_crawl_status.py.`
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

export async function postCrawlWave(payload, { url, token }) {
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
  let res;
  try {
    res = await fetch(url, {
      method: "POST",
      headers,
      body: JSON.stringify(payload),
      mode: "cors",
    });
  } catch (err) {
    const msg = err?.message || String(err);
    if (/failed to fetch|networkerror|cors/i.test(msg)) {
      throw new Error(
        "Browser blocked the webhook (CORS or network). Check the URL/token, or run the automation once from cursor.com/automations to confirm the endpoint."
      );
    }
    throw err;
  }
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
  return { status: res.status, body };
}
