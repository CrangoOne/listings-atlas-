/**
 * Browser port of daq/vin_market.py:
 * VIN → decode (EU local + NHTSA) → make/model/year(/fuel) comps.
 *
 * European VINs often fail US check-digit rules and NHTSA frequently returns
 * Make/year without Model (esp. VW commercial). We decode WMI + maker VDS
 * locally, then merge with NHTSA for fuel/body when available.
 */

export const NHTSA_URL =
  "https://vpic.nhtsa.dot.gov/api/vehicles/DecodeVinValues/{vin}?format=json";

export const VIN_RE = /^[A-HJ-NPR-Z0-9]{17}$/;

/** Common European WMIs → make (ISO 3780 / maker practice). */
export const EU_WMI_MAKE = {
  WVW: "VOLKSWAGEN",
  WVG: "VOLKSWAGEN",
  WV1: "VOLKSWAGEN",
  WV2: "VOLKSWAGEN",
  WV3: "VOLKSWAGEN",
  WVZ: "VOLKSWAGEN",
  "1VW": "VOLKSWAGEN",
  "3VW": "VOLKSWAGEN",
  WAU: "AUDI",
  WUA: "AUDI",
  TRU: "AUDI",
  WBA: "BMW",
  WBS: "BMW",
  WBY: "BMW",
  WB1: "BMW",
  WBX: "BMW",
  WMW: "MINI",
  WDB: "MERCEDES-BENZ",
  WDC: "MERCEDES-BENZ",
  WDD: "MERCEDES-BENZ",
  WDF: "MERCEDES-BENZ",
  W1K: "MERCEDES-BENZ",
  W1N: "MERCEDES-BENZ",
  W1V: "MERCEDES-BENZ",
  WME: "SMART",
  W1A: "SMART",
  TMB: "SKODA",
  TMP: "SKODA",
  VSS: "SEAT",
  VSK: "NISSAN",
  VF1: "RENAULT",
  VF3: "PEUGEOT",
  VF7: "CITROEN",
  VR1: "DS",
  ZFA: "FIAT",
  ZAR: "ALFA ROMEO",
  ZAM: "MASERATI",
  ZFF: "FERRARI",
  WP0: "PORSCHE",
  WP1: "PORSCHE",
  YV1: "VOLVO",
  YV4: "VOLVO",
  WF0: "FORD",
  WF1: "FORD",
  SAL: "LAND ROVER",
  SAJ: "JAGUAR",
  SJN: "NISSAN",
  TMA: "HYUNDAI",
  TMC: "TOYOTA",
  JHM: "HONDA",
  UU1: "DACIA",
};

/**
 * VW Group EU type codes in VIN positions 7–8 when VDS is ZZZ..Z style.
 * Sources: VW commercial chassis docs + common EU decoder tables.
 */
export const VW_EU_TYPE_CODES = {
  // Commercial / LCV
  "70": { model: "Transporter", series: "T4" },
  "7H": { model: "Transporter", series: "T5" },
  "7J": { model: "Transporter", series: "T6" },
  "7E": { model: "Crafter" },
  "2E": { model: "Crafter" },
  "2K": { model: "Caddy" },
  "2C": { model: "Caddy" },
  "2H": { model: "Amarok" },
  SH: { model: "Caddy" },
  // Passenger / crossover (common DE market)
  "1H": { model: "Golf", series: "III" },
  "1J": { model: "Golf", series: "IV" },
  "1K": { model: "Golf", series: "V" },
  "5K": { model: "Golf", series: "VI" },
  AU: { model: "Golf", series: "VII" },
  CD: { model: "Golf", series: "VIII" },
  "6R": { model: "Polo" },
  "6C": { model: "Polo" },
  AW: { model: "Polo" },
  "9N": { model: "Polo" },
  "3B": { model: "Passat", series: "B5" },
  "3C": { model: "Passat", series: "B6" },
  "3G": { model: "Passat", series: "B8" },
  "3H": { model: "Arteon" },
  "1T": { model: "Touran" },
  "5T": { model: "Touran" },
  "5N": { model: "Tiguan" },
  AD: { model: "Tiguan" },
  "7P": { model: "Touareg" },
  "7L": { model: "Touareg" },
  CR: { model: "Touareg" },
  AJ: { model: "T-Roc" },
  C1: { model: "T-Cross" },
  "1F": { model: "Eos" },
  "1C": { model: "Beetle" },
  "5C": { model: "Beetle" },
  "16": { model: "Jetta" },
  "1Y": { model: "New Beetle" },
  "8Z": { model: "A2" }, // Audi sometimes; ignore if WMI not Audi
  E1: { model: "ID.3" },
  E2: { model: "ID.4" },
  E3: { model: "ID.5" },
};

/** Škoda EU type codes (TMB + ZZZ..). */
export const SKODA_EU_TYPE_CODES = {
  "1U": { model: "Octavia" },
  "1Z": { model: "Octavia" },
  "5E": { model: "Octavia" },
  NX: { model: "Octavia" },
  "5J": { model: "Fabia" },
  NJ: { model: "Fabia" },
  "5L": { model: "Superb" },
  "3T": { model: "Superb" },
  "3V": { model: "Superb" },
  "5Z": { model: "Roomster" },
};

/** Audi EU type codes (WAU/TRU + ZZZ..). */
export const AUDI_EU_TYPE_CODES = {
  "8E": { model: "A4" },
  "8K": { model: "A4" },
  "8W": { model: "A4" },
  "8L": { model: "A3" },
  "8P": { model: "A3" },
  "8V": { model: "A3" },
  "8Y": { model: "A3" },
  "8D": { model: "A4" },
  "4B": { model: "A6" },
  "4F": { model: "A6" },
  "4G": { model: "A6" },
  "4K": { model: "A6" },
  "4E": { model: "A8" },
  "4H": { model: "A8" },
  "4N": { model: "A8" },
  "8R": { model: "Q5" },
  FY: { model: "Q5" },
  "8U": { model: "Q3" },
  F3: { model: "Q3" },
  "4L": { model: "Q7" },
  "4M": { model: "Q7" },
  "8T": { model: "A5" },
  "8F": { model: "A5" },
  F5: { model: "A5" },
  "8Z": { model: "A2" },
  "8N": { model: "TT" },
  "8J": { model: "TT" },
  FV: { model: "TT" },
};

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

/** EU-style VDS filler: positions 4–6 and often 9 are Z. */
export function isEuZzzStyleVin(vin) {
  const v = String(vin || "").toUpperCase();
  if (v.length !== 17) return false;
  return v[3] === "Z" && v[4] === "Z" && v[5] === "Z";
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

function lookupTypeCode(table, typeCode) {
  if (!typeCode) return null;
  return table[typeCode] || table[String(typeCode).toUpperCase()] || null;
}

/**
 * Local European VIN decode from WMI + common maker type codes.
 * Does not call the network. Returns null fields when unknown.
 */
export function decodeEuropeanVinLocal(vin) {
  const cleaned = normalizeVinStrict(vin);
  const wmi = cleaned.slice(0, 3);
  const make = EU_WMI_MAKE[wmi] || null;
  const typeCode = cleaned.slice(6, 8); // positions 7–8
  const year = yearFromVinPosition10(cleaned);
  const likelyEu = isLikelyEuVin(cleaned) || isEuZzzStyleVin(cleaned);
  let model = null;
  let series = null;
  let body = null;

  if (make === "VOLKSWAGEN" || make === "SEAT" || make === "CUPRA") {
    const hit = lookupTypeCode(VW_EU_TYPE_CODES, typeCode);
    if (hit) {
      model = hit.model;
      series = hit.series || null;
    } else if (wmi === "WV1" || wmi === "WV2" || wmi === "WV3") {
      model = "Commercial";
      body = "Truck";
    }
  } else if (make === "SKODA") {
    const hit = lookupTypeCode(SKODA_EU_TYPE_CODES, typeCode);
    if (hit) {
      model = hit.model;
      series = hit.series || null;
    }
  } else if (make === "AUDI") {
    const hit = lookupTypeCode(AUDI_EU_TYPE_CODES, typeCode);
    if (hit) {
      model = hit.model;
      series = hit.series || null;
    }
  }

  // Generation hint for VW Transporter by year when series missing/ambiguous.
  if (make === "VOLKSWAGEN" && model === "Transporter" && !series && year != null) {
    if (year <= 2003) series = "T4";
    else if (year <= 2015) series = "T5";
    else if (year <= 2019) series = "T6";
    else series = "T6.1";
  }

  return {
    vin: cleaned,
    wmi,
    type_code: typeCode,
    make,
    model,
    series,
    year,
    body,
    fuel: null,
    trim: null,
    plant: cleaned[10] || null,
    likely_eu: likelyEu,
    eu_zzz: isEuZzzStyleVin(cleaned),
    source: "eu_local",
  };
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

/** Extra listing needles for decoded model families (OR-matched in SQL). */
export const MODEL_FAMILY_ALIASES = {
  TRANSPORTER: ["TRANSPORTER", "MULTIVAN", "CARAVELLE", "CALIFORNIA", "T5", "T6"],
  AMAROK: ["AMAROK"],
  CRAFTER: ["CRAFTER", "MAN TGE"],
  CADDY: ["CADDY"],
  COMMERCIAL: ["TRANSPORTER", "AMAROK", "CADDY", "CRAFTER", "MULTIVAN"],
  GOLF: ["GOLF"],
  PASSAT: ["PASSAT"],
  TIGUAN: ["TIGUAN"],
  POLO: ["POLO"],
};

export function modelTokens(model) {
  const text = String(model || "").toUpperCase();
  const tokens = text.match(/[A-Z0-9.]{2,}/g) || [];
  const stop = new Set([
    "SERIES",
    "CLASS",
    "COUPE",
    "SEDAN",
    "WAGON",
    "SPORT",
    "TOURING",
    "COMMERCIAL",
  ]);
  const filtered = tokens
    .map((t) => t.replace(/\./g, ""))
    .filter((t) => t.length >= 2 && !stop.has(t));
  if (filtered.length) return filtered;
  const compact = compactAlnum(text);
  return compact && compact !== "COMMERCIAL" ? [compact] : [];
}

/** OR-needles for model matching (family aliases expand primary model). */
export function modelMatchNeedles(model) {
  const primary = modelTokens(model);
  const key = String(model || "")
    .trim()
    .toUpperCase();
  const family = MODEL_FAMILY_ALIASES[key] || MODEL_FAMILY_ALIASES[compactAlnum(key)];
  if (family && family.length) {
    return [...new Set([...primary, ...family.map((f) => f.toUpperCase())])];
  }
  return primary;
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

/** Soft NHTSA fetch — never throws on missing model (common for EU VINs). */
export async function fetchNhtsaDecode(vin, { timeoutMs = 20000 } = {}) {
  const cleaned = normalizeVinStrict(vin);
  const url = NHTSA_URL.replace("{vin}", encodeURIComponent(cleaned));
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(url, { signal: ctrl.signal });
    if (!res.ok) throw new Error(`NHTSA HTTP ${res.status}`);
    const payload = await res.json();
    const row = (payload.Results && payload.Results[0]) || {};
    const yearRaw = String(row.ModelYear || "").trim();
    return {
      vin: cleaned,
      make: String(row.Make || "").trim() || null,
      model: String(row.Model || "").trim() || null,
      year: /^\d{4}$/.test(yearRaw) ? Number(yearRaw) : null,
      body: row.BodyClass || null,
      fuel: row.FuelTypePrimary || null,
      series: row.Series || null,
      trim: row.Trim || null,
      displacement_l: row.DisplacementL || null,
      doors: row.Doors || null,
      plant_country: row.PlantCountry || null,
      vehicle_type: row.VehicleType || null,
      error_code: row.ErrorCode || null,
      error_text: row.ErrorText || null,
      source: "nhtsa",
    };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Merge EU local + NHTSA. Prefer NHTSA model when present; else local type code.
 * Requires at least a make (from either source).
 */
export function mergeVinDecodes(local, nhtsa) {
  const vin = (local && local.vin) || (nhtsa && nhtsa.vin);
  const vinYear = yearFromVinPosition10(vin);
  const make = (nhtsa && nhtsa.make) || (local && local.make) || null;
  let model = null;
  let modelSource = null;
  if (nhtsa && nhtsa.model) {
    model = nhtsa.model;
    modelSource = "nhtsa";
  } else if (local && local.model && local.model !== "Commercial") {
    model = local.model;
    modelSource = "eu_local";
  } else if (local && local.model) {
    model = local.model;
    modelSource = "eu_local";
  }

  const yearNhtsa = nhtsa && nhtsa.year != null ? nhtsa.year : null;
  const yearLocal = local && local.year != null ? local.year : null;
  const year =
    yearNhtsa != null ? yearNhtsa : yearLocal != null ? yearLocal : vinYear;
  const yearSource =
    yearNhtsa != null ? "nhtsa" : yearLocal != null || vinYear != null ? "vin_pos10" : null;

  const series =
    (nhtsa && nhtsa.series) || (local && local.series) || null;
  const body = (nhtsa && nhtsa.body) || (local && local.body) || null;
  const fuel = (nhtsa && nhtsa.fuel) || null;
  const hasMakeModel = Boolean(make && model);
  const error_code = (nhtsa && nhtsa.error_code) || null;
  const error_text = (nhtsa && nhtsa.error_text) || null;
  const likelyEu = Boolean(
    (local && local.likely_eu) || isLikelyEuVin(vin) || isEuZzzStyleVin(vin)
  );

  if (!make) {
    throw new Error(
      `Could not decode make for ${vin}` +
        (error_text ? `: ${error_text}` : " (unknown WMI / NHTSA empty)")
    );
  }

  const sources = [];
  if (local && local.make) sources.push("eu_local");
  if (nhtsa && (nhtsa.make || nhtsa.model || nhtsa.year != null)) sources.push("nhtsa");

  return {
    vin,
    make,
    model: model || "",
    year,
    year_nhtsa: yearNhtsa,
    year_vin: vinYear,
    year_source: yearSource,
    model_source: modelSource,
    decode_source: sources.join("+") || "none",
    likely_eu: likelyEu,
    eu_zzz: Boolean(local && local.eu_zzz) || isEuZzzStyleVin(vin),
    wmi: (local && local.wmi) || String(vin).slice(0, 3),
    type_code: (local && local.type_code) || String(vin).slice(6, 8),
    body,
    fuel,
    series,
    trim: (nhtsa && nhtsa.trim) || null,
    displacement_l: (nhtsa && nhtsa.displacement_l) || null,
    doors: (nhtsa && nhtsa.doors) || null,
    plant_country: (nhtsa && nhtsa.plant_country) || null,
    vehicle_type: (nhtsa && nhtsa.vehicle_type) || null,
    error_code,
    error_text,
    note: meaningfulNhtsaNote(error_code, error_text, { hasMakeModel }),
  };
}

/**
 * Full decode: EU local patterns + NHTSA enrichment.
 * Works for European VINs that NHTSA only partially understands.
 */
export async function decodeVin(vin, { timeoutMs = 20000 } = {}) {
  const cleaned = normalizeVinStrict(vin);
  const local = decodeEuropeanVinLocal(cleaned);
  let nhtsa = null;
  let nhtsaError = null;
  try {
    nhtsa = await fetchNhtsaDecode(cleaned, { timeoutMs });
  } catch (err) {
    nhtsaError = err;
    // Local-only path is fine when WMI/type code resolved a make.
    if (!local.make) {
      throw new Error(
        `VIN decode failed for ${cleaned}: ${err.message || err}`
      );
    }
  }
  const merged = mergeVinDecodes(local, nhtsa);
  if (nhtsaError && !merged.note) {
    merged.note = `NHTSA unavailable (${nhtsaError.message || nhtsaError}); used EU local decode`;
  }
  return merged;
}

/** @deprecated alias — use decodeVin */
export async function decodeVinNhtsa(vin, opts) {
  return decodeVin(vin, opts);
}

/**
 * How close a listing is to the decoded VIN vehicle.
 * Higher score = closer. Label: Strong / Close / Loose.
 */
export function scoreCompMatch(row, decoded, { yearTol = 1, fuelNeedles: needles = [] } = {}) {
  const reasons = [];
  let score = 0;
  const tokens = modelTokens(decoded.model);
  const modelNeedles = modelMatchNeedles(decoded.model);
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
  } else if (modelNeedles.length) {
    const hit = modelNeedles.some((n) => hayCompact.includes(compactAlnum(n)));
    if (hit) {
      score += 28;
      reasons.push("model family");
    } else {
      score += 4;
      reasons.push("model unknown");
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

  // Prefer AND of primary tokens; if none, OR family needles; if still none, make+year.
  const tokens = modelTokens(decoded.model);
  const needles = modelMatchNeedles(decoded.model);
  const hay = `upper(COALESCE(model,'') || ' ' || COALESCE(title,''))`;
  if (tokens.length) {
    for (const t of tokens) {
      clauses.push(`${hay} LIKE ?`);
      params.push(`%${t}%`);
    }
  } else if (needles.length) {
    const parts = needles.map(() => `${hay} LIKE ?`);
    for (const n of needles) params.push(`%${n}%`);
    clauses.push(`(${parts.join(" OR ")})`);
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
    needles,
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
