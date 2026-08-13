/**
 * Browser port of daq/vin_market.py:
 * VIN → NHTSA decode → make/model/year(/fuel) query for similar listings.
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
    return {
      vin: cleaned,
      make,
      model,
      year,
      body: row.BodyClass || null,
      fuel: row.FuelTypePrimary || null,
      series: row.Series || null,
      trim: row.Trim || null,
      displacement_l: row.DisplacementL || null,
      doors: row.Doors || null,
      plant_country: row.PlantCountry || null,
      error_code: row.ErrorCode || null,
      error_text: row.ErrorText || null,
    };
  } finally {
    clearTimeout(timer);
  }
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
