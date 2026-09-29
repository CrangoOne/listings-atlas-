import {
  VIN_RE,
  buildDecodedCompWhere,
  decodeVin,
  fuelNeedles,
  makeMatchSet,
  modelMatchNeedles,
  modelTokens,
  rowMatchesFuel,
  scoreCompMatch,
  summarizePrices,
} from "./vin_market.js";

const PAGE_SIZE = 50;
const IDB_NAME = "listings-atlas";
const IDB_STORE = "files";
const IDB_KEY = "car_library.db";
const LS_API_URL = "listings-atlas.queryApiUrl";
const LS_API_KEY = "listings-atlas.queryApiKey";
const DEFAULT_API_URL = "https://listings-atlas-query.fly.dev";

const SOURCE_LABEL = {
  willhaben: "Willhaben",
  autoscout: "AutoScout24",
  kleinanzeigen: "Kleinanzeigen",
  coches: "coches.net",
};

const fmt = new Intl.NumberFormat("en-US");
const euro = new Intl.NumberFormat("en-US", {
  style: "currency",
  currency: "EUR",
  maximumFractionDigits: 0,
});

function niceSource(id) {
  return SOURCE_LABEL[id] || id;
}

function escapeHtml(s) {
  return String(s ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

function debounce(fn, ms) {
  let t;
  return (...args) => {
    clearTimeout(t);
    t = setTimeout(() => fn(...args), ms);
  };
}

/** Strip to A-Z0-9 and uppercase for VIN comparison. */
function normalizeVin(value) {
  return String(value || "")
    .toUpperCase()
    .replace(/[^A-Z0-9]/g, "");
}

/** Common OCR / mistype confusions in VINs. */
function confuseVin(value) {
  return normalizeVin(value)
    .replace(/[OQ]/g, "0")
    .replace(/[IL]/g, "1")
    .replace(/S/g, "5")
    .replace(/B/g, "8")
    .replace(/Z/g, "2");
}

function levenshtein(a, b) {
  if (a === b) return 0;
  if (!a.length) return b.length;
  if (!b.length) return a.length;
  const row = new Array(b.length + 1);
  for (let j = 0; j <= b.length; j++) row[j] = j;
  for (let i = 1; i <= a.length; i++) {
    let prev = i - 1;
    row[0] = i;
    for (let j = 1; j <= b.length; j++) {
      const cur = row[j];
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      row[j] = Math.min(row[j] + 1, row[j - 1] + 1, prev + cost);
      prev = cur;
    }
  }
  return row[b.length];
}

/**
 * Lower is better. 0 = substring / strong match.
 * Uses sliding-window edit distance for near-full VINs and OCR lookalikes.
 */
function vinDistance(queryRaw, vinRaw) {
  const q = normalizeVin(queryRaw);
  const v = normalizeVin(vinRaw);
  if (!q || !v) return Infinity;
  if (v.includes(q) || (q.length >= 6 && q.includes(v))) return 0;

  const qc = confuseVin(q);
  const vc = confuseVin(v);
  if (vc.includes(qc)) return 0.5;

  let best = levenshtein(q, v);
  best = Math.min(best, levenshtein(qc, vc));

  // Compare query to windows of the stored VIN (handles partial + typos).
  if (q.length >= 5 && v.length >= q.length) {
    for (let i = 0; i <= v.length - q.length; i++) {
      const slice = v.slice(i, i + q.length);
      best = Math.min(best, levenshtein(q, slice));
      best = Math.min(best, levenshtein(qc, confuseVin(slice)));
      if (best === 0) break;
    }
  } else if (q.length >= 5 && q.length > v.length) {
    for (let i = 0; i <= q.length - v.length; i++) {
      best = Math.min(best, levenshtein(q.slice(i, i + v.length), v));
    }
  }

  // Prefer matches on the vehicle serial (VIN tail).
  const tailLen = Math.min(8, q.length);
  if (tailLen >= 5) {
    const qTail = q.slice(-tailLen);
    const vTail = v.slice(-tailLen);
    best = Math.min(best, levenshtein(qTail, vTail) + 0.25);
  }
  return best;
}

function vinDistanceThreshold(queryNorm) {
  const n = queryNorm.length;
  if (n <= 4) return 0; // short: substring only (via distance 0 / 0.5)
  if (n <= 8) return 2;
  if (n <= 12) return 3;
  return Math.max(3, Math.floor(n * 0.15));
}

async function idbGet(key) {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(IDB_NAME, 1);
    req.onupgradeneeded = () => req.result.createObjectStore(IDB_STORE);
    req.onerror = () => reject(req.error);
    req.onsuccess = () => {
      const db = req.result;
      const tx = db.transaction(IDB_STORE, "readonly");
      const get = tx.objectStore(IDB_STORE).get(key);
      get.onsuccess = () => resolve(get.result || null);
      get.onerror = () => reject(get.error);
    };
  });
}

async function idbSet(key, value) {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(IDB_NAME, 1);
    req.onupgradeneeded = () => req.result.createObjectStore(IDB_STORE);
    req.onerror = () => reject(req.error);
    req.onsuccess = () => {
      const db = req.result;
      const tx = db.transaction(IDB_STORE, "readwrite");
      tx.objectStore(IDB_STORE).put(value, key);
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    };
  });
}

function loadScript(src) {
  return new Promise((resolve, reject) => {
    const existing = document.querySelector(`script[src="${src}"]`);
    if (existing && window.initSqlJs) {
      resolve();
      return;
    }
    const s = document.createElement("script");
    s.src = src;
    s.async = true;
    s.onload = () => resolve();
    s.onerror = () => reject(new Error(`Failed to load ${src}`));
    document.head.append(s);
  });
}

async function loadSqlJs() {
  if (window.__SQL) return window.__SQL;
  await loadScript(
    "https://cdnjs.cloudflare.com/ajax/libs/sql.js/1.11.0/sql-wasm.js"
  );
  if (typeof window.initSqlJs !== "function") {
    throw new Error("sql.js failed to initialize");
  }
  const SQL = await window.initSqlJs({
    locateFile: (file) =>
      `https://cdnjs.cloudflare.com/ajax/libs/sql.js/1.11.0/${file}`,
  });
  window.__SQL = SQL;
  return SQL;
}

async function fetchWithProgress(url, onProgress) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`HTTP ${res.status} for ${url}`);
  const total = Number(res.headers.get("content-length") || 0);
  if (!res.body || !res.body.getReader) {
    const buf = await res.arrayBuffer();
    onProgress?.(1, buf.byteLength, buf.byteLength);
    return buf;
  }
  const reader = res.body.getReader();
  const chunks = [];
  let received = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
    received += value.byteLength;
    onProgress?.(total ? received / total : 0, received, total);
  }
  const out = new Uint8Array(received);
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return out.buffer;
}

function createCombo(
  root,
  { options = [], multiple = false, placeholder = "Any", onChange = null } = {}
) {
  root.innerHTML = "";
  root.classList.add("combo-ready");
  const selected = new Set();
  let filtered = options.slice();

  const control = document.createElement("div");
  control.className = "combo-control";
  const input = document.createElement("input");
  input.type = "search";
  input.placeholder = placeholder;
  input.setAttribute("aria-autocomplete", "list");
  const chips = document.createElement("div");
  chips.className = "combo-chips";
  const list = document.createElement("div");
  list.className = "combo-list";
  list.hidden = true;

  control.append(chips, input);
  root.append(control, list);

  function notify() {
    onChange?.();
  }

  function renderChips() {
    chips.innerHTML = "";
    for (const value of selected) {
      const chip = document.createElement("button");
      chip.type = "button";
      chip.className = "combo-chip";
      chip.textContent = niceSource(value) === value ? value : niceSource(value);
      if (SOURCE_LABEL[value]) chip.textContent = niceSource(value);
      chip.title = "Remove";
      chip.addEventListener("click", () => {
        selected.delete(value);
        if (!multiple) input.value = "";
        renderChips();
        renderList();
        notify();
      });
      chips.append(chip);
    }
  }

  function renderList() {
    const q = input.value.trim().toLowerCase();
    filtered = options.filter((o) => String(o).toLowerCase().includes(q));
    list.innerHTML = "";
    if (!filtered.length) {
      list.innerHTML = `<div class="combo-empty">No matches</div>`;
      return;
    }
    for (const opt of filtered.slice(0, 80)) {
      const btn = document.createElement("button");
      btn.type = "button";
      btn.className = "combo-option";
      if (selected.has(opt)) btn.classList.add("is-selected");
      btn.textContent = SOURCE_LABEL[opt] ? niceSource(opt) : opt;
      btn.addEventListener("click", () => {
        if (multiple) {
          if (selected.has(opt)) selected.delete(opt);
          else selected.add(opt);
        } else {
          selected.clear();
          selected.add(opt);
          list.hidden = true;
        }
        input.value = multiple ? "" : SOURCE_LABEL[opt] ? niceSource(opt) : opt;
        renderChips();
        renderList();
        notify();
      });
      list.append(btn);
    }
  }

  input.addEventListener("focus", () => {
    list.hidden = false;
    renderList();
  });
  input.addEventListener(
    "input",
    debounce(() => {
      list.hidden = false;
      renderList();
      notify();
    }, 80)
  );
  document.addEventListener("click", (e) => {
    if (!root.contains(e.target)) list.hidden = true;
  });

  return {
    setOptions(next) {
      options = next.slice();
      renderList();
    },
    getValues() {
      if (multiple) return [...selected];
      if (selected.size) return [...selected];
      const typed = input.value.trim();
      return typed ? [typed] : [];
    },
    clearValue(value) {
      if (value == null) {
        selected.clear();
        input.value = "";
      } else {
        selected.delete(value);
        if (!multiple && !selected.size) input.value = "";
      }
      renderChips();
      renderList();
      notify();
    },
    reset() {
      selected.clear();
      input.value = "";
      renderChips();
      renderList();
      notify();
    },
  };
}

export function initExplore(summary) {
  const gate = document.getElementById("db-gate");
  const app = document.getElementById("explore-app");
  const progress = document.getElementById("db-progress");
  const progressFill = document.getElementById("db-progress-fill");
  const progressLabel = document.getElementById("db-progress-label");
  const form = document.getElementById("filter-form");
  const resultMeta = document.getElementById("result-meta");
  const tbody = document.getElementById("results-body");
  const pager = document.getElementById("pager");
  const pageLabel = document.getElementById("page-label");
  const dialog = document.getElementById("row-dialog");
  const dialogTitle = document.getElementById("row-dialog-title");
  const dialogBody = document.getElementById("row-dialog-body");
  const vinPanel = document.getElementById("vin-decode-panel");
  const vinSummary = document.getElementById("vin-decode-summary");
  const vinStats = document.getElementById("vin-decode-stats");
  const activeChipsEl = document.getElementById("active-filter-chips");
  const moreFiltersEl = document.getElementById("more-filters");
  const moreFiltersBtn = document.getElementById("more-filters-btn");
  const vinSearchPanel = document.getElementById("vin-search-panel");
  const vinModeBtn = document.getElementById("vin-mode-btn");
  const stickyBar = document.getElementById("explore-sticky-bar");
  const stickyApplyBtn = document.getElementById("sticky-apply-btn");
  const applyFiltersBtn = document.getElementById("apply-filters-btn");

  let db = null;
  /** @type {{ base: string, key: string } | null} */
  let apiClient = null;
  let page = 0;
  let lastWhere = { sql: "1=1", params: [], vinQuery: "", mode: "filter" };
  let lastCount = 0;
  let lastVinRanked = null;
  let lastDecoded = null;

  const apiUrlEl = document.getElementById("db-api-url");
  const apiKeyEl = document.getElementById("db-api-key");
  if (apiUrlEl && !apiUrlEl.value) {
    apiUrlEl.value = localStorage.getItem(LS_API_URL) || DEFAULT_API_URL;
  }
  if (apiKeyEl && localStorage.getItem(LS_API_KEY) && !apiKeyEl.value) {
    apiKeyEl.placeholder = "Query key saved on this device";
  }

  function ready() {
    return Boolean(db || apiClient);
  }

  function euroChip(n) {
    const v = Number(n);
    if (!Number.isFinite(v)) return String(n);
    return euro.format(v);
  }

  function syncApplyLabels() {
    const label =
      lastCount > 0 ? `Show results (${fmt.format(lastCount)})` : "Show results";
    if (applyFiltersBtn) applyFiltersBtn.textContent = label;
    if (stickyApplyBtn) stickyApplyBtn.textContent = label;
  }

  function renderActiveChips() {
    if (!activeChipsEl) return;
    const chips = [];
    for (const s of combos.source.getValues()) {
      chips.push({ key: "source", value: s, label: niceSource(s) });
    }
    const make = combos.make.getValues()[0];
    if (make) chips.push({ key: "make", value: make, label: make });
    const model = form.model.value.trim();
    if (model) chips.push({ key: "model", value: model, label: `Model: ${model}` });
    const fuel = combos.fuel_type.getValues()[0];
    if (fuel) chips.push({ key: "fuel_type", value: fuel, label: fuel });
    const transmission = combos.transmission.getValues()[0];
    if (transmission) {
      chips.push({ key: "transmission", value: transmission, label: transmission });
    }
    const body = combos.body_type.getValues()[0];
    if (body) chips.push({ key: "body_type", value: body, label: body });
    const q = form.q?.value?.trim();
    if (q) chips.push({ key: "q", value: q, label: `“${q}”` });
    const vin = form.vin?.value?.trim();
    if (vin) chips.push({ key: "vin", value: vin, label: `VIN ${vin}` });

    const priceMin = form.price_min?.value?.trim();
    const priceMax = form.price_max?.value?.trim();
    if (priceMin || priceMax) {
      chips.push({
        key: "price",
        value: "",
        label: `€ ${priceMin ? euroChip(priceMin) : "…"}–${priceMax ? euroChip(priceMax) : "…"}`,
      });
    }
    const yearMin = form.year_min?.value?.trim();
    const yearMax = form.year_max?.value?.trim();
    if (yearMin || yearMax) {
      chips.push({
        key: "year",
        value: "",
        label: `Year ${yearMin || "…"}–${yearMax || "…"}`,
      });
    }
    const kmMin = form.km_min?.value?.trim();
    const kmMax = form.km_max?.value?.trim();
    if (kmMin || kmMax) {
      chips.push({
        key: "km",
        value: "",
        label: `Km ${kmMin || "…"}–${kmMax || "…"}`,
      });
    }
    const psMin = form.ps_min?.value?.trim();
    const psMax = form.ps_max?.value?.trim();
    if (psMin || psMax) {
      chips.push({
        key: "ps",
        value: "",
        label: `PS ${psMin || "…"}–${psMax || "…"}`,
      });
    }

    activeChipsEl.hidden = chips.length === 0;
    activeChipsEl.innerHTML = "";
    for (const chip of chips) {
      const btn = document.createElement("button");
      btn.type = "button";
      btn.className = "active-filter-chip";
      btn.textContent = `${chip.label} ×`;
      btn.title = `Clear ${chip.label}`;
      btn.addEventListener("click", () => {
        clearActiveChip(chip.key, chip.value);
        renderActiveChips();
      });
      activeChipsEl.append(btn);
    }
  }

  function clearActiveChip(key, value) {
    if (key === "source") combos.source.clearValue(value);
    else if (key === "make") combos.make.clearValue(value);
    else if (key === "fuel_type") combos.fuel_type.clearValue(value);
    else if (key === "transmission") combos.transmission.clearValue(value);
    else if (key === "body_type") combos.body_type.clearValue(value);
    else if (key === "model") form.model.value = "";
    else if (key === "q") form.q.value = "";
    else if (key === "vin") form.vin.value = "";
    else if (key === "price") {
      form.price_min.value = "";
      form.price_max.value = "";
    } else if (key === "year") {
      form.year_min.value = "";
      form.year_max.value = "";
    } else if (key === "km") {
      form.km_min.value = "";
      form.km_max.value = "";
    } else if (key === "ps") {
      form.ps_min.value = "";
      form.ps_max.value = "";
    }
  }

  function setMoreFiltersOpen(open) {
    if (!moreFiltersEl || !moreFiltersBtn) return;
    moreFiltersEl.hidden = !open;
    moreFiltersBtn.setAttribute("aria-expanded", open ? "true" : "false");
    moreFiltersBtn.textContent = open ? "Hide filters" : "More filters";
  }

  function setVinPanelOpen(open) {
    if (!vinSearchPanel || !vinModeBtn) return;
    vinSearchPanel.hidden = !open;
    vinModeBtn.setAttribute("aria-expanded", open ? "true" : "false");
    vinModeBtn.textContent = open ? "Hide VIN" : "Decode VIN";
    if (open) form.vin?.focus();
  }

  async function apiFetch(pathWithQuery) {
    if (!apiClient) throw new Error("Not connected to query API");
    const url = `${apiClient.base}${pathWithQuery}`;
    const res = await fetch(url, {
      headers: {
        Accept: "application/json",
        "X-Atlas-Key": apiClient.key,
      },
      cache: "no-store",
    });
    if (!res.ok) {
      let detail = "";
      try {
        detail = (await res.json())?.error || "";
      } catch {
        /* ignore */
      }
      throw new Error(detail || `HTTP ${res.status}`);
    }
    return res.json();
  }

  function collectFilterParams() {
    const p = new URLSearchParams();
    for (const s of combos.source.getValues()) p.append("source", s);
    const makes = combos.make.getValues();
    if (makes[0]) p.set("make", makes[0]);
    const fuels = combos.fuel_type.getValues();
    if (fuels[0]) p.set("fuel_type", fuels[0]);
    const transmissions = combos.transmission.getValues();
    if (transmissions[0]) p.set("transmission", transmissions[0]);
    const bodies = combos.body_type.getValues();
    if (bodies[0]) p.set("body_type", bodies[0]);
    const model = form.model.value.trim();
    if (model) p.set("model", model);
    const vin = (form.vin?.value || "").trim();
    if (vin) p.set("vin", vin);
    const q = form.q.value.trim();
    if (q) p.set("q", q);
    for (const [name, key] of [
      ["price_min", "price_min"],
      ["price_max", "price_max"],
      ["year_min", "year_min"],
      ["year_max", "year_max"],
      ["km_min", "km_min"],
      ["km_max", "km_max"],
      ["ps_min", "ps_min"],
      ["ps_max", "ps_max"],
    ]) {
      const v = form[name]?.value?.trim();
      if (v) p.set(key, v);
    }
    return p;
  }

  async function unlockExplore(label) {
    if (apiClient) {
      try {
        const facets = await apiFetch("/v1/facets/makes?limit=120");
        if (facets.makes?.length) combos.make.setOptions(facets.makes);
      } catch {
        /* keep summary facets */
      }
    }
    gate.hidden = true;
    app.hidden = false;
    if (stickyBar) stickyBar.hidden = false;
    progress.hidden = true;
    resultMeta.textContent = `${label}. Set make or filters, then Show results.`;
    renderActiveChips();
    syncApplyLabels();
  }

  async function connectApi() {
    const base = (apiUrlEl?.value || DEFAULT_API_URL).trim().replace(/\/+$/, "");
    const key = (apiKeyEl?.value || "").trim() || localStorage.getItem(LS_API_KEY) || "";
    if (!base) throw new Error("Enter the Fly query API URL.");
    if (!key) throw new Error("Enter ATLAS_QUERY_KEY (Fly secret / Cursor Runtime Secret).");
    setProgress(0.2, "Connecting to Fly query API…");
    localStorage.setItem(LS_API_URL, base);
    localStorage.setItem(LS_API_KEY, key);
    apiClient = { base, key };
    db = null;
    const health = await apiFetch("/v1/health");
    if (!health.db_ready) {
      throw new Error("API is up but the library DB is not on the volume yet.");
    }
    const meta = await apiFetch("/v1/meta");
    setProgress(0.9, "Connected…");
    await unlockExplore(
      `Connected to Fly · ${fmt.format(meta.total || 0)} listings (${meta.db_file || "DB"})`
    );
  }

  const combos = {
    source: createCombo(document.querySelector('[data-combo="source"]'), {
      options: summary.facets?.source || ["kleinanzeigen", "willhaben", "autoscout"],
      multiple: true,
      placeholder: "All sources",
      onChange: () => renderActiveChips(),
    }),
    make: createCombo(document.querySelector('[data-combo="make"]'), {
      options: summary.facets?.make || [],
      placeholder: "Search make…",
      onChange: () => renderActiveChips(),
    }),
    fuel_type: createCombo(document.querySelector('[data-combo="fuel_type"]'), {
      options: summary.facets?.fuel_type || [],
      placeholder: "Search fuel…",
      onChange: () => renderActiveChips(),
    }),
    transmission: createCombo(document.querySelector('[data-combo="transmission"]'), {
      options: summary.facets?.transmission || [],
      placeholder: "Search transmission…",
      onChange: () => renderActiveChips(),
    }),
    body_type: createCombo(document.querySelector('[data-combo="body_type"]'), {
      options: summary.facets?.body_type || [],
      placeholder: "Search body…",
      onChange: () => renderActiveChips(),
    }),
  };

  const ranges = summary.ranges || {};
  if (ranges.price_eur) {
    form.price_min.placeholder = String(ranges.price_eur[0] ?? "Min");
    form.price_max.placeholder = String(ranges.price_eur[1] ?? "Max");
  }
  if (ranges.year_int) {
    form.year_min.placeholder = String(ranges.year_int[0] ?? "Min");
    form.year_max.placeholder = String(ranges.year_int[1] ?? "Max");
  }

  function setProgress(frac, label) {
    progress.hidden = false;
    progressFill.style.width = `${Math.max(2, Math.min(100, frac * 100))}%`;
    progressLabel.textContent = label;
  }

  async function openDbFromBuffer(buffer, label) {
    setProgress(0.95, `Opening ${label}…`);
    const SQL = await loadSqlJs();
    db = new SQL.Database(new Uint8Array(buffer));
    apiClient = null;
    try {
      const res = db.exec(
        `SELECT make FROM listings
         WHERE make IS NOT NULL AND trim(make) NOT IN ('','N/A')
         GROUP BY make ORDER BY COUNT(*) DESC LIMIT 120`
      );
      if (res[0]) combos.make.setOptions(res[0].values.map((v) => v[0]));
    } catch {
      /* ignore */
    }
    await unlockExplore(`Loaded ${label}`);
  }

  async function loadLocalFile(file) {
    setProgress(0.05, `Reading ${file.name}…`);
    const buffer = await file.arrayBuffer();
    await openDbFromBuffer(buffer, file.name);
  }

  function buildWhere() {
    const clauses = [];
    const params = [];

    const sources = combos.source.getValues();
    if (sources.length) {
      clauses.push(`source IN (${sources.map(() => "?").join(",")})`);
      params.push(...sources);
    }

    const makes = combos.make.getValues();
    if (makes.length) {
      clauses.push(`lower(make) = lower(?)`);
      params.push(makes[0]);
    }

    const fuels = combos.fuel_type.getValues();
    if (fuels.length) {
      clauses.push(`lower(fuel_type) = lower(?)`);
      params.push(fuels[0]);
    }

    const transmissions = combos.transmission.getValues();
    if (transmissions.length) {
      clauses.push(`lower(transmission) = lower(?)`);
      params.push(transmissions[0]);
    }

    const bodies = combos.body_type.getValues();
    if (bodies.length) {
      clauses.push(`lower(body_type) = lower(?)`);
      params.push(bodies[0]);
    }

    const model = form.model.value.trim();
    if (model) {
      clauses.push(`lower(COALESCE(model,'')) LIKE lower(?)`);
      params.push(`%${model}%`);
    }

    // Partial VIN string similarity (when not a full 17-char decode).
    const vinRaw = (form.vin?.value || "").trim();
    const vinQuery = normalizeVin(vinRaw);
    const looksFullVin = VIN_RE.test(vinQuery);
    if (!looksFullVin && vinQuery.length >= 4) {
      const vinExpr = `upper(REPLACE(REPLACE(REPLACE(COALESCE(vin,''),' ',''),'-',''),'.',''))`;
      const vinConf = confuseVin(vinQuery);
      const parts = [`${vinExpr} LIKE ?`, `${vinExpr} LIKE ?`];
      params.push(`%${vinQuery}%`, `%${vinConf}%`);
      if (vinQuery.length >= 6) {
        parts.push(`${vinExpr} LIKE ?`);
        params.push(`%${vinQuery.slice(-6)}%`);
      }
      if (vinQuery.length >= 8) {
        parts.push(`${vinExpr} LIKE ?`);
        params.push(`%${vinQuery.slice(3, 11)}%`);
      }
      if (vinQuery.length >= 10) {
        parts.push(`${vinExpr} LIKE ?`);
        params.push(`%${vinQuery.slice(0, 4)}%${vinQuery.slice(-4)}%`);
      }
      clauses.push(`(vin IS NOT NULL AND vin != '' AND vin != 'N/A' AND (${parts.join(" OR ")}))`);
    } else if (!looksFullVin && vinRaw) {
      clauses.push(`upper(COALESCE(vin,'')) LIKE ?`);
      params.push(`%${vinRaw.toUpperCase()}%`);
    }

    const q = form.q.value.trim();
    if (q) {
      clauses.push(`(
        lower(COALESCE(title,'')) LIKE lower(?)
        OR lower(COALESCE(location,'')) LIKE lower(?)
        OR lower(COALESCE(ad_id,'')) LIKE lower(?)
      )`);
      const like = `%${q}%`;
      params.push(like, like, like);
    }

    const addRange = (col, minEl, maxEl) => {
      const min = minEl.value.trim();
      const max = maxEl.value.trim();
      if (min !== "") {
        clauses.push(`${col} >= ?`);
        params.push(Number(min));
      }
      if (max !== "") {
        clauses.push(`${col} <= ?`);
        params.push(Number(max));
      }
    };
    addRange("price_eur", form.price_min, form.price_max);
    // For full-VIN decode comps, year window comes from decode (± year_tol).
    if (!looksFullVin) {
      addRange("year_int", form.year_min, form.year_max);
    }
    addRange("mileage_km", form.km_min, form.km_max);
    addRange("power_ps", form.ps_min, form.ps_max);

    return {
      sql: clauses.length ? clauses.join(" AND ") : "1=1",
      params,
      vinQuery: !looksFullVin && vinQuery.length >= 4 ? vinQuery : "",
      fullVin: looksFullVin ? vinQuery : "",
      mode: looksFullVin ? "decode" : vinQuery.length >= 4 ? "vin-similar" : "filter",
    };
  }

  function hideVinPanel() {
    if (vinPanel) vinPanel.hidden = true;
    lastDecoded = null;
  }

  function showVinPanel(decoded, stats, { fuelApplied, comps }) {
    if (!vinPanel) return;
    vinPanel.hidden = false;
    const bits = [
      decoded.make,
      decoded.model,
      decoded.year != null ? `(${decoded.year})` : "",
      decoded.fuel || "",
      decoded.body || "",
    ]
      .filter(Boolean)
      .join(" ");
    const meta = [];
    if (decoded.likely_eu) meta.push("EU VIN");
    if (decoded.decode_source) meta.push(decoded.decode_source);
    if (decoded.model_source === "eu_local") meta.push("model from EU type code");
    else if (decoded.model_source === "nhtsa") meta.push("model from NHTSA");
    if (decoded.year_source === "vin_pos10") meta.push("year from VIN pos.10");
    else if (decoded.year_source === "nhtsa") meta.push("year from NHTSA");
    if (decoded.series) meta.push(`series ${decoded.series}`);
    if (decoded.eu_zzz) meta.push("US check-digit N/A");
    if (decoded.eu_no_year) meta.push("year not encoded (EU)");
    if (decoded.note) meta.push(`note: ${decoded.note}`);
    vinSummary.textContent = `${decoded.vin} → ${bits} · ${meta.join(" · ")}`;
    const euroOr = (v) => (v == null ? "—" : euro.format(v));
    vinStats.innerHTML = `
      <div class="vin-stat"><span>Comps</span><strong>${fmt.format(comps)}</strong></div>
      <div class="vin-stat"><span>Median €</span><strong>${euroOr(stats.median)}</strong></div>
      <div class="vin-stat"><span>p25–p75</span><strong>${euroOr(stats.p25)} – ${euroOr(stats.p75)}</strong></div>
      <div class="vin-stat"><span>Min–Max</span><strong>${euroOr(stats.min)} – ${euroOr(stats.max)}</strong></div>
      <div class="vin-stat"><span>Fuel filter</span><strong>${fuelApplied ? "on" : "relaxed"}</strong></div>
    `;
  }

  async function runDecodedVinQuery(fullVin, resetPage) {
    // Pagination reuse: keep decoded comps without re-calling NHTSA.
    if (!resetPage && lastDecoded && lastVinRanked && lastWhere.fullVin === fullVin) {
      lastCount = lastVinRanked.length;
      const offset = page * PAGE_SIZE;
      const slice = lastVinRanked.slice(offset, offset + PAGE_SIZE).map((x) => ({
        ...x.row,
        _match_score: x.match?.score,
        _match_label: x.match?.label,
        _match_reasons: x.match?.reasons,
      }));
      renderRows(slice, { showMatch: true });
      const from = lastCount ? offset + 1 : 0;
      const to = Math.min(offset + PAGE_SIZE, lastCount);
      resultMeta.textContent = `${fmt.format(lastCount)} comps for decoded ${lastDecoded.make} ${lastDecoded.model} · showing ${from}–${to} (closest first)`;
      pager.hidden = lastCount <= PAGE_SIZE;
      pageLabel.textContent = `Page ${page + 1} / ${Math.max(1, Math.ceil(lastCount / PAGE_SIZE))}`;
      document.getElementById("page-prev").disabled = page <= 0;
      document.getElementById("page-next").disabled = offset + PAGE_SIZE >= lastCount;
      syncApplyLabels();
      return;
    }

    resultMeta.textContent = "Decoding VIN (EU local + NHTSA)…";
    const yearTol = Math.max(0, Number(form.year_tol?.value ?? 1) || 0);
    let decoded;
    try {
      decoded = await decodeVin(fullVin);
    } catch (err) {
      hideVinPanel();
      resultMeta.textContent = `VIN decode failed: ${err.message || err}`;
      tbody.innerHTML = `<tr class="empty-row"><td colspan="11">Could not decode VIN.</td></tr>`;
      pager.hidden = true;
      return;
    }
    lastDecoded = decoded;

    // Prefill visible filters so the user sees what was queried.
    if (form.model) form.model.value = decoded.model || "";
    if (decoded.year != null) {
      form.year_min.value = String(decoded.year - yearTol);
      form.year_max.value = String(decoded.year + yearTol);
    }

    const comp = buildDecodedCompWhere(decoded, { yearTol, preferFuel: true });

    // Decoded make/model/year plus optional source/price/mileage filters.
    const extra = [];
    const extraParams = [];
    const sources = combos.source.getValues();
    if (sources.length) {
      extra.push(`source IN (${sources.map(() => "?").join(",")})`);
      extraParams.push(...sources);
    }
    const kmMin = form.km_min.value.trim();
    const kmMax = form.km_max.value.trim();
    if (kmMin !== "") {
      extra.push("mileage_km >= ?");
      extraParams.push(Number(kmMin));
    }
    if (kmMax !== "") {
      extra.push("mileage_km <= ?");
      extraParams.push(Number(kmMax));
    }
    const priceMin = form.price_min.value.trim();
    const priceMax = form.price_max.value.trim();
    if (priceMin !== "") {
      extra.push("price_eur >= ?");
      extraParams.push(Number(priceMin));
    }
    if (priceMax !== "") {
      extra.push("price_eur <= ?");
      extraParams.push(Number(priceMax));
    }

    const sql = [comp.sql, ...extra].filter(Boolean).join(" AND ");
    const params = [...comp.params, ...extraParams];
    lastWhere = { sql, params, vinQuery: "", fullVin, mode: "decode" };

    let candidates = [];
    if (apiClient) {
      const p = new URLSearchParams();
      p.set("mode", "comps");
      p.set("year_tol", String(yearTol));
      if (decoded.year != null) p.set("decoded_year", String(decoded.year));
      if (decoded.make) p.set("decoded_make", decoded.make);
      for (const a of makeMatchSet(decoded.make)) p.append("make_alias", a);
      for (const t of modelTokens(decoded.model)) p.append("model_token", t);
      for (const n of modelMatchNeedles(decoded.model)) p.append("model_needle", n);
      for (const s of sources) p.append("source", s);
      if (kmMin !== "") p.set("km_min", kmMin);
      if (kmMax !== "") p.set("km_max", kmMax);
      if (priceMin !== "") p.set("price_min", priceMin);
      if (priceMax !== "") p.set("price_max", priceMax);
      resultMeta.textContent = "Fetching comps from Fly…";
      const body = await apiFetch(`/v1/listings?${p}`);
      candidates = body.rows || [];
    } else {
      const selectSql = `SELECT source, ad_id, make, model, year, year_int, price, price_eur,
              mileage, mileage_km, power, power_ps, fuel_type, transmission,
              body_type, location, vin, url, title, scraped_at, updated
       FROM listings
       WHERE ${sql}`;
      const stmt = db.prepare(`${selectSql} LIMIT 5000`);
      if (params.length) stmt.bind(params);
      while (stmt.step()) candidates.push(stmt.getAsObject());
      stmt.free();
    }

    let comps = candidates;
    let fuelApplied = false;
    const needles = comp.fuelNeedles.length ? comp.fuelNeedles : fuelNeedles(decoded.fuel);
    if (needles.length) {
      const withFuel = candidates.filter((r) => rowMatchesFuel(r, needles));
      if (withFuel.length >= Math.min(5, candidates.length) && withFuel.length > 0) {
        comps = withFuel;
        fuelApplied = true;
      }
    }

    lastVinRanked = comps
      .map((row) => ({
        row,
        match: scoreCompMatch(row, decoded, { yearTol, fuelNeedles: needles }),
      }))
      .sort((a, b) => {
        if (b.match.score !== a.match.score) return b.match.score - a.match.score;
        const pa = a.row.price_eur;
        const pb = b.row.price_eur;
        if (pa == null && pb == null) return 0;
        if (pa == null) return 1;
        if (pb == null) return -1;
        return pa - pb;
      });

    const stats = summarizePrices(comps);
    showVinPanel(decoded, stats, { fuelApplied, comps: comps.length });

    lastCount = lastVinRanked.length;
    const offset = page * PAGE_SIZE;
    const slice = lastVinRanked.slice(offset, offset + PAGE_SIZE).map((x) => ({
      ...x.row,
      _match_score: x.match.score,
      _match_label: x.match.label,
      _match_reasons: x.match.reasons,
    }));
    renderRows(slice, { showMatch: true });
    const from = lastCount ? offset + 1 : 0;
    const to = Math.min(offset + PAGE_SIZE, lastCount);
    resultMeta.textContent = `${fmt.format(lastCount)} comps for decoded ${decoded.make} ${decoded.model} · showing ${from}–${to} (closest first)`;
    pager.hidden = lastCount <= PAGE_SIZE;
    pageLabel.textContent = `Page ${page + 1} / ${Math.max(1, Math.ceil(lastCount / PAGE_SIZE))}`;
    document.getElementById("page-prev").disabled = page <= 0;
    document.getElementById("page-next").disabled = offset + PAGE_SIZE >= lastCount;
      syncApplyLabels();
  }

  async function runQuery(resetPage = true) {
    if (!ready()) return;
    if (resetPage) {
      page = 0;
      lastVinRanked = null;
    }

    const draft = buildWhere();
    if (draft.mode === "decode" && draft.fullVin) {
      await runDecodedVinQuery(draft.fullVin, resetPage);
      return;
    }

    hideVinPanel();
    lastWhere = draft;

    // Partial VIN similar-match path: pull candidates, rank by edit distance.
    if (lastWhere.vinQuery) {
      if (!lastVinRanked) {
        let candidates = [];
        if (apiClient) {
          const p = collectFilterParams();
          p.set("mode", "vin_similar");
          const body = await apiFetch(`/v1/listings?${p}`);
          candidates = body.rows || [];
        } else {
          const selectSql = `SELECT source, ad_id, make, model, year, year_int, price, price_eur,
              mileage, mileage_km, power, power_ps, fuel_type, transmission,
              body_type, location, vin, url, title, scraped_at, updated
       FROM listings
       WHERE ${lastWhere.sql}`;
          const stmt = db.prepare(`${selectSql} LIMIT 3000`);
          if (lastWhere.params.length) stmt.bind(lastWhere.params);
          while (stmt.step()) candidates.push(stmt.getAsObject());
          stmt.free();
        }

        const threshold = vinDistanceThreshold(lastWhere.vinQuery);
        lastVinRanked = candidates
          .map((row) => {
            const dist = vinDistance(lastWhere.vinQuery, row.vin);
            return { row, dist };
          })
          .filter((x) => x.dist <= threshold)
          .sort((a, b) => {
            if (a.dist !== b.dist) return a.dist - b.dist;
            const pa = a.row.price_eur;
            const pb = b.row.price_eur;
            if (pa == null && pb == null) return 0;
            if (pa == null) return 1;
            if (pb == null) return -1;
            return pa - pb;
          });
      }

      lastCount = lastVinRanked.length;
      const offset = page * PAGE_SIZE;
      const slice = lastVinRanked.slice(offset, offset + PAGE_SIZE).map((x) => ({
        ...x.row,
        _vin_distance: x.dist,
      }));
      renderRows(slice, { showVinScore: true });
      const from = lastCount ? offset + 1 : 0;
      const to = Math.min(offset + PAGE_SIZE, lastCount);
      resultMeta.textContent = `${fmt.format(lastCount)} similar VIN string matches · showing ${from}–${to}`;
      pager.hidden = lastCount <= PAGE_SIZE;
      pageLabel.textContent = `Page ${page + 1} / ${Math.max(1, Math.ceil(lastCount / PAGE_SIZE))}`;
      document.getElementById("page-prev").disabled = page <= 0;
      document.getElementById("page-next").disabled = offset + PAGE_SIZE >= lastCount;
      syncApplyLabels();
      return;
    }

    if (apiClient) {
      const p = collectFilterParams();
      p.set("mode", "filter");
      p.set("page", String(page));
      p.set("page_size", String(PAGE_SIZE));
      const body = await apiFetch(`/v1/listings?${p}`);
      lastCount = body.total || 0;
      const rows = body.rows || [];
      const offset = page * PAGE_SIZE;
      renderRows(rows);
      const from = lastCount ? offset + 1 : 0;
      const to = Math.min(offset + PAGE_SIZE, lastCount);
      resultMeta.textContent = `${fmt.format(lastCount)} matches · showing ${from}–${to}`;
      pager.hidden = lastCount <= PAGE_SIZE;
      pageLabel.textContent = `Page ${page + 1} / ${Math.max(1, Math.ceil(lastCount / PAGE_SIZE))}`;
      document.getElementById("page-prev").disabled = page <= 0;
      document.getElementById("page-next").disabled = offset + PAGE_SIZE >= lastCount;
      syncApplyLabels();
      return;
    }

    const selectSql = `SELECT source, ad_id, make, model, year, year_int, price, price_eur,
              mileage, mileage_km, power, power_ps, fuel_type, transmission,
              body_type, location, vin, url, title, scraped_at, updated
       FROM listings
       WHERE ${lastWhere.sql}`;

    const countStmt = db.prepare(`SELECT COUNT(*) AS c FROM listings WHERE ${lastWhere.sql}`);
    if (lastWhere.params.length) countStmt.bind(lastWhere.params);
    lastCount = countStmt.step() ? countStmt.getAsObject().c || 0 : 0;
    countStmt.free();

    const offset = page * PAGE_SIZE;
    const stmt = db.prepare(
      `${selectSql}
       ORDER BY price_eur IS NULL, price_eur ASC, make, model
       LIMIT ${PAGE_SIZE} OFFSET ${offset}`
    );
    if (lastWhere.params.length) stmt.bind(lastWhere.params);

    const rows = [];
    while (stmt.step()) rows.push(stmt.getAsObject());
    stmt.free();

    renderRows(rows);
    const from = lastCount ? offset + 1 : 0;
    const to = Math.min(offset + PAGE_SIZE, lastCount);
    resultMeta.textContent = `${fmt.format(lastCount)} matches · showing ${from}–${to}`;
    pager.hidden = lastCount <= PAGE_SIZE;
    pageLabel.textContent = `Page ${page + 1} / ${Math.max(1, Math.ceil(lastCount / PAGE_SIZE))}`;
    document.getElementById("page-prev").disabled = page <= 0;
    document.getElementById("page-next").disabled = offset + PAGE_SIZE >= lastCount;
      syncApplyLabels();
  }

  function listingUrl(row) {
    const u = String(row?.url || "").trim();
    if (!u || u.toUpperCase() === "N/A") return "";
    return u;
  }

  function renderRows(rows, { showVinScore = false, showMatch = false } = {}) {
    if (!rows.length) {
      tbody.innerHTML = `<tr class="empty-row"><td colspan="11">No rows match these filters.</td></tr>`;
      return;
    }
    tbody.innerHTML = rows
      .map((r) => {
        const payload = encodeURIComponent(JSON.stringify(r));
        const vinText = r.vin || "—";
        const vinCell =
          showVinScore && r._vin_distance != null && r._vin_distance > 0
            ? `${escapeHtml(vinText)} <span class="vin-score">~${Number(r._vin_distance).toFixed(0)}</span>`
            : escapeHtml(vinText);
        const href = listingUrl(r);
        const linkCell = href
          ? `<a class="row-link" href="${escapeHtml(href)}" target="_blank" rel="noopener" title="Open original listing">Open</a>`
          : "—";
        let matchCell = "—";
        if (showMatch && r._match_label != null) {
          const cls =
            r._match_label === "Strong"
              ? "match-strong"
              : r._match_label === "Close"
                ? "match-close"
                : "match-loose";
          matchCell = `<span class="match-pill ${cls}" title="${escapeHtml(
            (r._match_reasons || []).join(", ")
          )}">${escapeHtml(r._match_label)} ${fmt.format(r._match_score ?? 0)}</span>`;
        } else if (showVinScore && r._vin_distance != null) {
          matchCell = `<span class="match-pill match-close">~${Number(r._vin_distance).toFixed(0)}</span>`;
        }
        return `<tr class="result-row" data-row="${payload}">
          <td>${matchCell}</td>
          <td>${escapeHtml(niceSource(r.source))}</td>
          <td>${escapeHtml(r.make || "—")}</td>
          <td>${escapeHtml(r.model || "—")}</td>
          <td>${escapeHtml(r.year_int || r.year || "—")}</td>
          <td>${r.price_eur != null ? euro.format(r.price_eur) : escapeHtml(r.price || "—")}</td>
          <td>${r.mileage_km != null ? fmt.format(r.mileage_km) : escapeHtml(r.mileage || "—")}</td>
          <td class="vin-cell">${vinCell}</td>
          <td>${escapeHtml(r.fuel_type || "—")}</td>
          <td>${escapeHtml(r.location || "—")}</td>
          <td class="link-cell">${linkCell}</td>
        </tr>`;
      })
      .join("");
  }

  function openRow(row) {
    dialogTitle.textContent = `${niceSource(row.source)} · ${row.make || ""} ${row.model || ""}`.trim();
    const href = listingUrl(row);
    const skip = new Set(["_vin_distance", "_match_score", "_match_label", "_match_reasons"]);
    const entries = Object.entries(row).filter(
      ([k, v]) => !skip.has(k) && v != null && String(v).trim() !== ""
    );
    // Put URL first for validation.
    entries.sort(([a], [b]) => {
      if (a === "url") return -1;
      if (b === "url") return 1;
      return 0;
    });
    const openBtn = href
      ? `<p class="detail-url-bar">
           <a class="btn primary" href="${escapeHtml(href)}" target="_blank" rel="noopener">Open original listing</a>
           <a class="detail-url-text" href="${escapeHtml(href)}" target="_blank" rel="noopener">${escapeHtml(href)}</a>
         </p>`
      : `<p class="detail-url-bar muted">No listing URL on this row.</p>`;
    const matchBlock =
      row._match_label != null
        ? `<p class="detail-match"><span class="match-pill ${
            row._match_label === "Strong"
              ? "match-strong"
              : row._match_label === "Close"
                ? "match-close"
                : "match-loose"
          }">${escapeHtml(row._match_label)} ${fmt.format(row._match_score ?? 0)}</span>
          <span class="detail-match-reasons">${escapeHtml((row._match_reasons || []).join(" · "))}</span></p>`
        : "";
    dialogBody.innerHTML = `${openBtn}${matchBlock}<dl class="row-dl">
      ${entries
        .map(
          ([k, v]) => `<div><dt>${escapeHtml(k)}</dt><dd>${
            k === "url"
              ? `<a href="${escapeHtml(v)}" target="_blank" rel="noopener">${escapeHtml(v)}</a>`
              : escapeHtml(v)
          }</dd></div>`
        )
        .join("")}
    </dl>`;
    dialog.showModal();
  }

  document.getElementById("db-file").addEventListener("change", async (e) => {
    const file = e.target.files?.[0];
    if (!file) return;
    try {
      await loadLocalFile(file);
    } catch (err) {
      progress.hidden = true;
      alert(`Failed to open DB: ${err.message || err}`);
    }
  });

  document.getElementById("db-api-connect")?.addEventListener("click", async () => {
    try {
      await connectApi();
    } catch (err) {
      progress.hidden = true;
      apiClient = null;
      alert(`Fly connect failed: ${err.message || err}`);
    }
  });

  moreFiltersBtn?.addEventListener("click", () => {
    setMoreFiltersOpen(Boolean(moreFiltersEl?.hidden));
  });
  vinModeBtn?.addEventListener("click", () => {
    setVinPanelOpen(Boolean(vinSearchPanel?.hidden));
  });

  form.addEventListener(
    "input",
    debounce(() => {
      renderActiveChips();
    }, 100)
  );

  form.addEventListener("submit", (e) => {
    e.preventDefault();
    setMoreFiltersOpen(false);
    runQuery(true)
      .then(() => {
        syncApplyLabels();
        document.getElementById("results-table")?.scrollIntoView({
          behavior: "smooth",
          block: "start",
        });
      })
      .catch((err) => {
        console.error(err);
        resultMeta.textContent = `Query failed: ${err.message || err}`;
      });
  });

  form.addEventListener("reset", () => {
    Object.values(combos).forEach((c) => c.reset());
    lastVinRanked = null;
    lastCount = 0;
    hideVinPanel();
    setVinPanelOpen(false);
    setMoreFiltersOpen(false);
    setTimeout(() => {
      tbody.innerHTML = `<tr class="empty-row"><td colspan="11">Filters cleared.</td></tr>`;
      resultMeta.textContent = "Filters reset — show results to search again.";
      pager.hidden = true;
      renderActiveChips();
      syncApplyLabels();
    }, 0);
  });

  document.getElementById("page-prev").addEventListener("click", () => {
    if (page > 0) {
      page -= 1;
      runQuery(false).catch(console.error);
    }
  });
  document.getElementById("page-next").addEventListener("click", () => {
    if ((page + 1) * PAGE_SIZE < lastCount) {
      page += 1;
      runQuery(false).catch(console.error);
    }
  });

  tbody.addEventListener("click", (e) => {
    // Let the Open link work without also opening the detail dialog.
    if (e.target.closest("a.row-link")) return;
    const tr = e.target.closest("tr[data-row]");
    if (!tr) return;
    try {
      openRow(JSON.parse(decodeURIComponent(tr.dataset.row)));
    } catch (err) {
      console.error(err);
    }
  });

  // Warm path: if IDB already has a local DB, offer one-click resume.
  idbGet(IDB_KEY)
    .then((cached) => {
      if (!cached || !gate || gate.hidden) return;
      const btn = document.createElement("button");
      btn.type = "button";
      btn.className = "btn ghost";
      btn.textContent = "Use cached local DB";
      btn.addEventListener("click", () => openDbFromBuffer(cached, "cached DB"));
      document.querySelector(".db-actions")?.append(btn);
    })
    .catch(() => {});

  // Auto-connect when URL + key are already saved (demo convenience).
  const savedKey = localStorage.getItem(LS_API_KEY);
  const savedUrl = localStorage.getItem(LS_API_URL) || DEFAULT_API_URL;
  if (savedKey && apiUrlEl) {
    connectApi().catch(() => {
      /* leave gate open */
    });
  } else if (savedUrl && apiUrlEl && !apiUrlEl.value) {
    apiUrlEl.value = savedUrl;
  }
}
