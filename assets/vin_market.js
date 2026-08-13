/**
 * Browser port of daq/vin_market.py:
 * VIN → NHTSA decode → make/model/year(/fuel) query for similar listings.
 *
 * Tuned for mostly EU VINs: NHTSA is still used for WMI/make/model (free + CORS),
 * but US check-digit / "invalid character" noise is ignored, and model year can
 * fall back to VIN position 10 when NHTSA omits it.
 */

export const NHTSA_URL =
  "https://vpic.nhtsa.dot.gov/api/vehicles/DecodeVinValues/{vin}?format=json";

export const VIN_RE = /^[A-HJ-NPR-Z0-9]{17}$/;

export const MAKE_ALIASES = {
  BMW: ["BMW"],
  VOLKSWAGEN: ["VOLKSWAGEN", "VW"],
  "MERCEDES-BENZ": ["MERCEDES-BENZ", "MERCEDES", "MERCEDES BENZ", "MERCEDES_BENZ"],
  AUDI: ["AUDI"],
  OPEL: ["OPEL"],
  FORD: ["FORD"],
  TOYOTA: ["TOYOTA"],
  SKODA: ["SKODA", "ŠKODA"],
  SEAT: ["SEAT"],
  HYUNDAI: ["HYUNDAI"],
  KIA: ["KIA"],
  RENAULT: ["RENAULT"],
  PEUGEOT: ["PEUGEOT"],
  CITROEN: ["CITROEN", "CITROËN"],
  FIAT: ["FIAT"],
  MAZDA: ["MAZDA"],
  NISSAN: ["NISSAN"],
  VOLVO: ["VOLVO"],
  PORSCHE: ["PORSCHE"],
  MINI: ["MINI"],
  TESLA: ["TESLA"],
  CUPRA: ["CUPRA"],
  SUZUKI: ["SUZUKI"],
  MITSUBISHI: ["MITSUBISHI"],
  HONDA: ["HONDA"],
  JEEP: ["JEEP"],
  "ALFA ROMEO": ["ALFA ROMEO", "ALFA_ROMEO", "ALFAROMEO"],
  "LAND ROVER": ["LAND ROVER", "LAND_ROVER", "LANDROVER"],
  SMART: ["SMART"],
  CHEVROLET: ["CHEVROLET"],
  MG: ["MG"],
  BYD: ["BYD"],
  DACIA: ["DACIA"],
};

/** Map NHTSA fuel → listing fuel_type needles (upper). */
export const FUEL_ALIASES = {
  GASOLINE: ["GASOLINE", "PETROL", "BENZIN", "SUPER", "BLEIFREI", "OTTO"],
  DIESEL: ["DIESEL"],
  ELECTRIC: ["ELECTRIC", "ELEKTRO", "ELECTRICITY", "BEV"],
  "COMPRESSED NATURAL GAS (CNG)": ["CNG", "ERDGAS"],
  "LIQUEFIED PETROLEUM GAS (LPG)": ["LPG", "AUTOGAS", "GAS"],
  ETHANOL: ["ETHANOL", "E85"],
  HYBRID: ["HYBRID"],
  "PLUG-IN HYBRID": ["PLUG-IN", "PHEV", "PLUGIN"],
  FLEXIBLE: ["FLEX", "FLEXFUEL"],
};

export function normalizeVinStrict(vin) {
  const cleaned = String(vin || "")
    .toUpperCase()
    .replace(/[\s\-]/g, "");
  if (!VIN_RE.test(cleaned)) {
    throw new Error(`Invalid VIN (need 17 chars, no I/O/Q): ${vin}`);
  }
  return cleaned;
}

/** Rough EU/UK WMI hint from the first VIN character (not exhaustive). */
export function isLikelyEuVin(vin) {
  const c = String(vin || "").toUpperCase()[0];
  return "STUVWXYZ".includes(c);
}

/**
 * Model year from VIN position 10 (ISO 3779).
 * Covers 2001–2009 (1–9) and 2010–2030 (A–Y, skipping I/O/Q/U/Z).
 */
export function yearFromVinPosition10(vin) {
  const code = String(vin || "").toUpperCase()[9];
  if (!code) return null;
  if (code >= "1" && code <= "9") return 2000 + Number(code);
  const map = {
    A: 2010,
    B: 2011,
    C: 2012,
    D: 2013,
    E: 2014,
    F: 2015,
    G: 2016,
    H: 2017,
    J: 2018,
    K: 2019,
    L: 2020,
    M: 2021,
    N: 2022,
    P: 2023,
    R: 2024,
    S: 2025,
    T: 2026,
    V: 2027,
    W: 2028,
    X: 2029,
    Y: 2030,
  };
  return map[code] ?? null;
}

export function compactAlnum(s) {
  return String(s || "")
    .toUpperCase()
    .replace(/[^A-Z0-9]/g, "");
}

export function makeMatchSet(make) {
  const key = String(make || "")
    .trim()
    .toUpperCase();
  if (MAKE_ALIASES[key]) {
    return new Set(MAKE_ALIASES[key].map((a) => a.toUpperCase()));
  }
  const compact = compactAlnum(key);
  for (const [canon, aliases] of Object.entries(MAKE_ALIASES)) {
    if (compact === compactAlnum(canon)) {
      return new Set(aliases.map((a) => a.toUpperCase()));
    }
  }
  return new Set([key, key.replace(/-/g, " "), key.replace(/\s+/g, "")].filter(Boolean));
}

export function modelTokens(model) {
  const text = String(model || "").toUpperCase();
  const tokens = text.match(/[A-Z0-9]{2,}/g) || [];
  const stop = new Set(["SERIES", "CLASS", "COUPE", "SEDAN", "WAGON", "SPORT", "TOURING"]);
  const filtered = tokens.filter((t) => !stop.has(t));
  if (filtered.length) return filtered;
  const compact = compactAlnum(text);
  return compact ? [compact] : [];
}

export function fuelNeedles(fuel) {
  if (!fuel) return [];
  const key = String(fuel).trim().toUpperCase();
  if (FUEL_ALIASES[key]) return FUEL_ALIASES[key];
  for (const [canon, aliases] of Object.entries(FUEL_ALIASES)) {
    if (key.includes(canon) || canon.includes(key)) return aliases;
  }
  // Hybrid catch-all
  if (key.includes("HYBRID")) return FUEL_ALIASES.HYBRID.concat(FUEL_ALIASES["PLUG-IN HYBRID"]);
  if (key.includes("ELECTRIC")) return FUEL_ALIASES.ELECTRIC;
  if (key.includes("DIESEL")) return FUEL_ALIASES.DIESEL;
  if (key.includes("GAS")) return FUEL_ALIASES.GASOLINE;
  return [key];
}

/**
 * NHTSA often returns non-fatal codes even when Make/Model decode fine.
 * Hide the noisy ones from the UI when we already have a usable vehicle.
 */
const BENIGN_NHTSA_CODES = new Set([
  "0", // success
  "1", // check digit (9th position) — very common on EU / non-US VINs
  "7", // manufacturer not registered with NHTSA
  "8", // no detailed data available
  "14", // incomplete / some fields unavailable
  "400", // "invalid characters" — often a false alarm after successful decode
]);

function splitNhtsaCodes(errorCode) {
  return String(errorCode || "")
    .split(/[,;|]/)
    .map((c) => c.trim())
    .filter(Boolean);
}

function splitNhtsaMessages(errorText) {
  return String(errorText || "")
    .split(/;\s*/)
    .map((m) => m.trim())
    .filter(Boolean);
}

/** Keep only messages that are not the usual benign NHTSA warnings. */
export function meaningfulNhtsaNote(errorCode, errorText, { hasMakeModel = true } = {}) {
  const codes = splitNhtsaCodes(errorCode);
  const messages = splitNhtsaMessages(errorText);
  if (!messages.length) return null;

  const actionable = messages.filter((msg) => {
    const codeMatch = msg.match(/^(\d+)\b/);
    const code = codeMatch ? codeMatch[1] : "";
    if (code && BENIGN_NHTSA_CODES.has(code)) return false;
    // Text fallbacks when code prefix is missing from a fragment.
    const lower = msg.toLowerCase();
    if (hasMakeModel) {
      if (lower.includes("check digit")) return false;
      if (lower.includes("invalid characters present")) return false;
      if (lower.includes("manufacturer is not registered")) return false;
    }
    if (code === "0" || lower === "0 - vin decoded clean. check digit (9th position) is correct") {
      return false;
    }
    return true;
  });

  // If every code is benign and make/model exist, stay silent.
  if (hasMakeModel && codes.length && codes.every((c) => BENIGN_NHTSA_CODES.has(c))) {
    return null;
  }
  return actionable.length ? actionable.join("; ") : null;
}

export async function decodeVinNhtsa(vin, { timeoutMs = 20000 } = {}) {
  const cleaned = normalizeVinStrict(vin);
  const url = NHTSA_URL.replace("{vin}", encodeURIComponent(cleaned));
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(url, { signal: ctrl.signal });
    if (!res.ok) throw new Error(`NHTSA HTTP ${res.status}`);
    const payload = await res.json();
    const row = (payload.Results && payload.Results[0]) || {};
    const make = String(row.Make || "").trim();
    const model = String(row.Model || "").trim();
    const yearRaw = String(row.ModelYear || "").trim();
    const year = /^\d{4}$/.test(yearRaw) ? Number(yearRaw) : null;
    if (!make || !model) {
      throw new Error(
        `NHTSA could not decode make/model for ${cleaned}: ${row.ErrorText || "unknown"}`
      );
    }
    const error_code = row.ErrorCode || null;
    const error_text = row.ErrorText || null;
    const vinYear = yearFromVinPosition10(cleaned);
    const yearSource =
      year != null ? "nhtsa" : vinYear != null ? "vin_pos10" : null;
    const resolvedYear = year != null ? year : vinYear;
    const likelyEu = isLikelyEuVin(cleaned);
    return {
      vin: cleaned,
      make,
      model,
      year: resolvedYear,
      year_nhtsa: year,
      year_vin: vinYear,
      year_source: yearSource,
      likely_eu: likelyEu,
      body: row.BodyClass || null,
      fuel: row.FuelTypePrimary || null,
      series: row.Series || null,
      trim: row.Trim || null,
      displacement_l: row.DisplacementL || null,
      doors: row.Doors || null,
      plant_country: row.PlantCountry || null,
      error_code,
      error_text,
      // UI-facing note: omit routine check-digit / char warnings (common on EU VINs).
      note: meaningfulNhtsaNote(error_code, error_text, { hasMakeModel: true }),
    };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * How close a listing is to the decoded VIN vehicle.
 * Higher score = closer. Label: Strong / Close / Loose.
 */
export function scoreCompMatch(row, decoded, { yearTol = 1, fuelNeedles: needles = [] } = {}) {
  const reasons = [];
  let score = 0;
  const tokens = modelTokens(decoded.model);
  const modelCompact = compactAlnum(row.model);
  const titleCompact = compactAlnum(row.title);
  const hayCompact = modelCompact + titleCompact;

  // Make is required by the SQL filter — small base credit.
  score += 10;
  reasons.push("make");

  // Model token placement (field beats title-only).
  if (tokens.length) {
    const inModel = tokens.filter((t) => modelCompact.includes(compactAlnum(t))).length;
    const inHay = tokens.filter((t) => hayCompact.includes(compactAlnum(t))).length;
    if (inModel === tokens.length) {
      score += 35;
      reasons.push("model field");
    } else if (inModel > 0) {
      score += 22;
      reasons.push("partial model");
    } else if (inHay === tokens.length) {
      score += 14;
      reasons.push("model in title");
    } else {
      score += 6;
      reasons.push("weak model");
    }
  }

  // Year distance.
  if (decoded.year != null && row.year_int != null) {
    const d = Math.abs(Number(row.year_int) - Number(decoded.year));
    if (d === 0) {
      score += 30;
      reasons.push("year exact");
    } else if (d === 1) {
      score += 18;
      reasons.push("year ±1");
    } else if (d <= yearTol) {
      score += 8;
      reasons.push(`year ±${d}`);
    } else {
      reasons.push(`year ±${d}`);
    }
  } else {
    reasons.push("year unknown");
  }

  // Fuel.
  const fuel = String(row.fuel_type || "").toUpperCase();
  if (needles.length) {
    if (fuel && fuel !== "N/A" && fuel !== "UNKNOWN" && needles.some((n) => fuel.includes(n))) {
      score += 15;
      reasons.push("fuel");
    } else if (!fuel || fuel === "N/A" || fuel === "UNKNOWN") {
      score += 4;
      reasons.push("fuel unknown");
    } else {
      reasons.push("fuel mismatch");
    }
  }

  // Series / trim hints in title/model (EU ads often put "320d", "Sportline", etc.).
  const series = compactAlnum(decoded.series);
  const trim = compactAlnum(decoded.trim);
  if (series && series.length >= 2 && hayCompact.includes(series)) {
    score += 6;
    reasons.push("series");
  }
  if (trim && trim.length >= 2 && hayCompact.includes(trim)) {
    score += 4;
    reasons.push("trim");
  }

  score = Math.max(0, Math.min(100, Math.round(score)));
  const label = score >= 80 ? "Strong" : score >= 55 ? "Close" : "Loose";
  return { score, label, reasons };
}

/**
 * Build SQL WHERE fragments for comps from a decoded VIN (vin_market.filter_comps).
 */
export function buildDecodedCompWhere(decoded, { yearTol = 1, preferFuel = true } = {}) {
  const clauses = [];
  const params = [];

  const aliases = [...makeMatchSet(decoded.make)];
  const makeParts = [];
  for (const a of aliases) {
    makeParts.push("upper(trim(COALESCE(make,''))) = ?");
    params.push(a);
    makeParts.push("replace(upper(COALESCE(make,'')),' ','') = ?");
    params.push(a.replace(/\s+/g, ""));
  }
  clauses.push(`(${makeParts.join(" OR ")})`);

  const tokens = modelTokens(decoded.model);
  if (!tokens.length) {
    return { sql: "0", params: [], tokens, aliases, yearTol };
  }
  const hay = `upper(COALESCE(model,'') || ' ' || COALESCE(title,''))`;
  for (const t of tokens) {
    clauses.push(`${hay} LIKE ?`);
    params.push(`%${t}%`);
  }

  if (decoded.year != null) {
    clauses.push("year_int IS NOT NULL AND year_int BETWEEN ? AND ?");
    params.push(decoded.year - yearTol, decoded.year + yearTol);
  }

  // Soft fuel filter applied in JS after fetch (so we can relax if empty).
  return {
    sql: clauses.join(" AND "),
    params,
    tokens,
    aliases,
    yearTol,
    fuelNeedles: preferFuel ? fuelNeedles(decoded.fuel) : [],
  };
}

export function rowMatchesFuel(row, needles) {
  if (!needles || !needles.length) return true;
  const fuel = String(row.fuel_type || "").toUpperCase();
  if (!fuel || fuel === "N/A" || fuel === "UNKNOWN") return true; // keep unknowns
  return needles.some((n) => fuel.includes(n));
}

export function summarizePrices(rows) {
  const prices = rows
    .map((r) => r.price_eur)
    .filter((p) => p != null && Number.isFinite(Number(p)))
    .map(Number)
    .sort((a, b) => a - b);
  if (!prices.length) {
    return { count: 0, min: null, p25: null, median: null, p75: null, max: null, mean: null };
  }
  const percentile = (p) => {
    const k = (prices.length - 1) * p;
    const f = Math.floor(k);
    const c = Math.min(f + 1, prices.length - 1);
    if (f === c) return prices[f];
    return prices[f] + (prices[c] - prices[f]) * (k - f);
  };
  const sum = prices.reduce((a, b) => a + b, 0);
  return {
    count: prices.length,
    min: prices[0],
    p25: Math.round(percentile(0.25)),
    median: Math.round(percentile(0.5)),
    p75: Math.round(percentile(0.75)),
    max: prices[prices.length - 1],
    mean: Math.round(sum / prices.length),
  };
}
