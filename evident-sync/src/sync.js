// ============================================================
// Evident → CSV Sync Script
// Outputs:
//   insureds.csv           — one row per insured
//   coverages.csv          — one row per coverage per insured
//   custom_fields.csv      — coverage-level JSON policy data
//   custom_properties.csv  — entity-level custom properties (Contract Number,
//                            Notification List, Email, Entity Type, etc.)
//   criteria.csv           — non-compliance reasons per insured
//   summaries.csv          — one row per client (KPI counts)
// ============================================================

"use strict";

const https = require("https");
const zlib  = require("zlib");
const fs    = require("fs");
const path  = require("path");
const { smartWrite, writeSyncMetadata } = require("./sync-utils");

// ------------------------------------------------------------
// CLIENTS
// ------------------------------------------------------------
const CLIENTS = [
  { name: "A G Equipment Company",               rpCommonName: "agequipment",       apiKey: process.env.EVIDENT_KEY_AGEQUIPMENT },
  { name: "Action Plumbing Construction",        rpCommonName: "actionplumbing",    apiKey: process.env.EVIDENT_KEY_ACTIONPLUMBING },
  { name: "Bauer Foundation Corp.",              rpCommonName: "bauerfoundation",   apiKey: process.env.EVIDENT_KEY_BAUERFOUNDATION },
  { name: "Canadian Pacific Kansas City",        rpCommonName: "cpkansascity",      apiKey: process.env.EVIDENT_KEY_CPKANSASCITY },
  { name: "Capital Railroad Contracting, Inc.",  rpCommonName: "capitalroad",       apiKey: process.env.EVIDENT_KEY_CAPITALROAD },
  { name: "EMMES",                               rpCommonName: "emmes",             apiKey: process.env.EVIDENT_KEY_EMMES },
  { name: "ESS Companies",                       rpCommonName: "emerysappandsons",  apiKey: process.env.EVIDENT_KEY_EMERYSAPPANDSONS },
  { name: "Gart Properties",                     rpCommonName: "gartproperties",    apiKey: process.env.EVIDENT_KEY_GARTPROPERTIES },
  { name: "Kolb Grading",                        rpCommonName: "kolbgrading",       apiKey: process.env.EVIDENT_KEY_KOLBGRADING },
  { name: "Mizuho Bank",                         rpCommonName: "mizuhobank",        apiKey: process.env.EVIDENT_KEY_MIZUHOBANK },
  { name: "Musselman & Hall Contractors, LLC",   rpCommonName: "musselmanhall",     apiKey: process.env.EVIDENT_KEY_MUSSELMANHALL },
  { name: "Paragon Geophysical Services, Inc.",  rpCommonName: "paragongeo",        apiKey: process.env.EVIDENT_KEY_PARAGONGEO },
  { name: "Scandroli Construction",              rpCommonName: "scandroli",         apiKey: process.env.EVIDENT_KEY_SCANDROLI },
  { name: "Skyline Developers Construction LLC", rpCommonName: "skyline",           apiKey: process.env.EVIDENT_KEY_SKYLINE },
  { name: "The Abbey Management Company",        rpCommonName: "theabbeycompany",   apiKey: process.env.EVIDENT_KEY_THEABBEYCOMPANY },
  { name: "Trinity Chemical Industries LLC",     rpCommonName: "trinitychemical",   apiKey: process.env.EVIDENT_KEY_TRINITYCHEMICAL },
  { name: "United Coal Company LLC",             rpCommonName: "unitedcoal",        apiKey: process.env.EVIDENT_KEY_UNITEDCOAL },
];

const BASE_URL      = "https://verify.api.evidentid.com/api/v1";
const DATA_DIR      = path.join(__dirname, "..", "data");
const CLIENT_THREADS = 8;   // clients processed in parallel
const CONCURRENCY    = 20;  // concurrent per-insured requests per client

let detailDebugDone = false; // only fetch individual insured detail once per run

// ------------------------------------------------------------
// TIMESTAMP — Central Time with date AND time
// ------------------------------------------------------------
function getSyncTimestamp() {
  return new Date().toLocaleString("en-US", {
    timeZone:  "America/Chicago",
    year:      "numeric",
    month:     "2-digit",
    day:       "2-digit",
    hour:      "2-digit",
    minute:    "2-digit",
    second:    "2-digit",
    hour12:    false,
  }).replace(",", ""); // e.g. "04/22/2026 11:55:30"
}

// Also write a sync_date (date only) for backward compat with Power BI
function getSyncDate() {
  return new Date().toLocaleString("en-US", {
    timeZone: "America/Chicago",
    year:     "numeric",
    month:    "2-digit",
    day:      "2-digit",
  }); // e.g. "04/22/2026"
}

// ------------------------------------------------------------
// HTTP HELPER — handles gzip automatically
// ------------------------------------------------------------
function apiGet(rpCommonName, apiKey, endpoint, params = {}) {
  return new Promise((resolve, reject) => {
    const credentials = Buffer.from(`${rpCommonName}:${apiKey}`).toString("base64");
    const qs = Object.keys(params).length
      ? "?" + Object.entries(params).map(([k, v]) => `${k}=${encodeURIComponent(v)}`).join("&")
      : "";
    const url = `${BASE_URL}${endpoint}${qs}`;

    https.get(url, {
      headers: {
        Authorization:     `Basic ${credentials}`,
        "Content-Type":    "application/json",
        "Accept-Encoding": "gzip, deflate",
      },
    }, (res) => {
      const enc = res.headers["content-encoding"] || "";
      let stream = res;
      if (enc.includes("gzip"))    stream = res.pipe(zlib.createGunzip());
      if (enc.includes("deflate")) stream = res.pipe(zlib.createInflate());

      let data = "";
      stream.on("data", c => (data += c));
      stream.on("end", () => {
        if (res.statusCode === 404) { resolve(null); return; }
        if (res.statusCode >= 200 && res.statusCode < 300) {
          try { resolve(JSON.parse(data)); }
          catch (e) { reject(new Error(`JSON parse error on ${endpoint}: ${e.message}`)); }
        } else {
          reject(new Error(`HTTP ${res.statusCode} on ${endpoint}: ${data.slice(0, 200)}`));
        }
      });
      stream.on("error", reject);
    }).on("error", reject);
  });
}

// ------------------------------------------------------------
// PAGINATION HELPER
// ------------------------------------------------------------
async function fetchAllInsureds(rpCommonName, apiKey) {
  const insureds = [];
  const limit = 100;
  let skip = 0;
  while (true) {
    const res = await apiGet(rpCommonName, apiKey, "/insurance/insureds", { limit, skip });
    if (!res) break;
    const records = res.records || [];
    insureds.push(...records);
    const total = res.navigation?.total ?? records.length;
    if (insureds.length >= total || records.length === 0) break;
    skip += limit;
    // no delay needed — Evident API handles concurrent pagination fine
  }
  return insureds;
}

// ------------------------------------------------------------
// CONCURRENCY POOL
// ------------------------------------------------------------
async function pooled(items, limit, fn) {
  const results = [];
  let i = 0;
  async function worker() {
    while (i < items.length) {
      const idx = i++;
      results[idx] = await fn(items[idx], idx);
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return results;
}

// ------------------------------------------------------------
// CSV HELPERS
// ------------------------------------------------------------
function csvEscape(v) {
  if (v === null || v === undefined) return "";
  const s = String(v);
  return (s.includes(",") || s.includes('"') || s.includes("\n"))
    ? `"${s.replace(/"/g, '""')}"` : s;
}

function toCsv(rows) {
  if (!rows || rows.length === 0) return "";
  const headers = Object.keys(rows[0]);
  return [
    headers.join(","),
    ...rows.map(r => headers.map(h => csvEscape(r[h])).join(","))
  ].join("\n");
}

// ------------------------------------------------------------
// PROCESS ONE CLIENT
// ------------------------------------------------------------
async function processClient(client) {
  const { name, rpCommonName, apiKey } = client;
  const insuredRows      = [];
  const coverageRows     = [];
  const customFieldRows  = [];
  const customPropRows   = [];
  const criteriaRows     = [];
  const errorLog         = [];

  const syncTimestamp = getSyncTimestamp();
  const syncDate      = getSyncDate();

  console.log(`\n📋 Starting: ${name}`);

  // 1. Field definitions for entity-level custom properties
  //    e.g. Contract Number, Notification List, Email, Entity Type, etc.
  let fieldDefs = {}; // fieldId -> fieldName
  try {
    const defs = await apiGet(rpCommonName, apiKey, "/insurance/config/insureds/fields");
    // fieldDefs: UUID -> {id, name, key}
    // fieldDefsList: ordered array for positional insuredFields mapping
    if (Array.isArray(defs)) {
      for (const f of defs) {
        if (f.id) fieldDefs[f.id] = { id: f.id, name: f.name || f.id, key: f.key || f.id };
      }
    }
    const fieldDefsList = Array.isArray(defs) ? defs : [];
    console.log(`   Field defs: ${fieldDefsList.length}`);
  } catch (err) {
    errorLog.push({ client: name, stage: "field_defs", error: err.message });
  }

  // 2. Fetch all insureds
  let insureds = [];
  try {
    insureds = await fetchAllInsureds(rpCommonName, apiKey);
    console.log(`   Insureds: ${insureds.length}`);

  } catch (err) {
    errorLog.push({ client: name, stage: "insureds", error: err.message });
    return { insuredRows, coverageRows, customFieldRows, customPropRows, criteriaRows, errorLog };
  }

  // 3. Program summary
  let summary = { compliant: 0, nonCompliant: 0, pending: 0, total: insureds.length };
  try {
    const s = await apiGet(rpCommonName, apiKey, "/insurance/summary");
    if (s) {
      summary.compliant    = s.compliantCount    ?? s.compliant    ?? s.statistics?.compliantCount    ?? 0;
      summary.nonCompliant = s.nonCompliantCount ?? s.nonCompliant ?? s.statistics?.nonCompliantCount ?? 0;
      summary.pending      = s.pendingCount      ?? s.pending      ?? s.statistics?.pendingCount      ?? 0;
    }
  } catch (err) {
    // Fall back to counting from insured records
    for (const ins of insureds) {
      const st = (ins.complianceStatus || ins.status || "").toUpperCase();
      if (st === "COMPLIANT")     summary.compliant++;
      else if (st === "PENDING")  summary.pending++;
      else                        summary.nonCompliant++;
    }
  }

  // 4. Per-insured: coverages, custom fields (coverage-level), custom properties (entity-level), criteria
  await pooled(insureds, CONCURRENCY, async (insured) => {
    const insuredId          = insured.id || "";
    const insuredName        = insured.displayName || insured.name || insured.companyName || "";
    const contactEmail       = insured.contactEmail || insured.email || "";
    const contactName        = insured.contactName || "";
    const complianceStatus   = insured.complianceStatus || insured.status || "";
    const verificationStatus = insured.verificationStatus || "";
    const nextExpiration     = insured.nextExpiration || insured.nextExpirationDate || "";
    const active             = insured.active !== false;
    const paused             = insured.paused === true;
    const address            = insured.address || {};
    const country            = address.country || insured.country || "";
    const city               = address.city    || insured.city    || "";
    const state              = address.state   || insured.state   || "";

    insuredRows.push({
      client:                name,
      insured_id:            insuredId,
      insured_name:          insuredName,
      legal_name:            insured.legalName || "",
      primary_contact_email: contactEmail,
      primary_contact_name:  contactName,
      compliance_status:     complianceStatus,
      verification_status:   verificationStatus,
      next_expiration:       nextExpiration,
      active,
      paused,
      country,
      city,
      state,
      sync_date:             syncDate,
      sync_timestamp:        syncTimestamp,
    });

    // ── Entity-level Custom Properties ──────────────────────────────
    // These come from the insured object's properties array.
    // Structure: [{field: {id, name}, value}]
    // OR from the RP-scoped insured endpoint if not embedded.
    let propList = [];

    if (Array.isArray(insured.properties) && insured.properties.length > 0) {
      propList = insured.properties;
    } else if (Array.isArray(insured.customProperties) && insured.customProperties.length > 0) {
      propList = insured.customProperties;
    } else {
      // Fallback: RP-scoped endpoint for custom properties
      try {
        const rpRes = await apiGet(rpCommonName, apiKey, `/insurance/insureds/${insuredId}`);
        propList = rpRes?.properties || rpRes?.customProperties || rpRes?.fields || [];
      } catch (_) { /* endpoint may not exist for all clients */ }
    }

    for (const prop of propList) {
      const fieldId   = prop.field?.id   || prop.fieldId   || prop.id   || "";
      const fieldName = prop.field?.name || prop.fieldName || prop.name ||
                        fieldDefs[fieldId] || fieldId || "";
      const rawValue  = prop.value !== undefined ? prop.value : prop.fieldValue;
      const fieldValue = rawValue === null || rawValue === undefined ? "" :
                         typeof rawValue === "object" ? JSON.stringify(rawValue) : String(rawValue);
      if (!fieldName) continue;
      customPropRows.push({
        client:         name,
        insured_id:     insuredId,
        insured_name:   insuredName,
        field_id:       fieldId,
        field_name:     fieldName,
        field_value:    fieldValue,
        sync_date:      syncDate,
        sync_timestamp: syncTimestamp,
      });
    }

    // ── Coverage data from /data endpoint ─────────────────────────────
    // Returns object keyed by coverage type: {COMMERCIAL_GENERAL_LIABILITY: {coverageId, policy, details,...}}
    try {
      const dataRes = await apiGet(rpCommonName, apiKey, `/insurance/insureds/${insuredId}/data`);
      if (dataRes && typeof dataRes === "object" && !Array.isArray(dataRes)) {
        for (const [covType, covData] of Object.entries(dataRes)) {
          if (!covData) continue;
          const policy  = covData.policy  || {};
          const details = covData.details || {};

          coverageRows.push({
            client:                name,
            insured_id:            insuredId,
            primary_contact_email: contactEmail,
            insured_name:          insuredName,
            coverage_type:         covType,
            coverage_id:           covData.coverageId  || "",
            policy_number:         policy.policyNumber  || "",
            insurer:               policy.carrier?.name || "",
            effective_date:        policy.effectiveDate  || "",
            expiration_date:       policy.expirationDate || "",
            per_occurrence:        details.eachOccurrenceLimit || details.perOccurrenceLimit || "",
            aggregate:             details.generalAggregateLimit || details.aggregateLimit   || "",
            combined_single_limit: details.combinedSingleLimitEachAccident || "",
            created_at:            covData.createdAt || "",
            sync_date:             syncDate,
            sync_timestamp:        syncTimestamp,
          });

          customFieldRows.push({
            client:         name,
            insured_id:     insuredId,
            insured_name:   insuredName,
            field_id:       covType,
            field_label:    covType,
            field_value:    JSON.stringify(covData),
            sync_date:      syncDate,
            sync_timestamp: syncTimestamp,
          });
        }
      }
    } catch (err) {
      errorLog.push({ client: name, stage: "coverage_data", insured: insuredId, error: err.message });
    }

    // ── Entity custom properties from insuredFields ───────────────────
    // Positional array — index i maps to fieldDefsList[i]; null = not set
    const insuredFieldsArr = Array.isArray(insured.insuredFields) ? insured.insuredFields : [];
    insuredFieldsArr.forEach((fieldVal, i) => {
      if (fieldVal === null || fieldVal === undefined) return;
      const fieldDef  = fieldDefsList[i] || {};
      const fieldName = fieldDef.name || fieldDef.key || `field_${i}`;
      const fieldKey  = fieldDef.key  || fieldDef.id  || `field_${i}`;
      const fieldValue = typeof fieldVal === "object" ? JSON.stringify(fieldVal) : String(fieldVal);
      if (!fieldValue.trim()) return;
      customPropRows.push({
        client:         name,
        insured_id:     insuredId,
        insured_name:   insuredName,
        field_key:      fieldKey,
        field_name:     fieldName,
        field_value:    fieldValue,
        sync_date:      syncDate,
        sync_timestamp: syncTimestamp,
      });
    });

    // ── Criteria (non-compliance reasons) ──
    // Skip /status call entirely for compliant/pending insureds — they have no
    // non-compliance reasons, so this saves ~33% of all API calls.
    const skipStatus = ["COMPLIANT", "PENDING", "NEW"].includes(
      (complianceStatus || "").toUpperCase()
    );
    try {
      const statusRes = skipStatus
        ? null
        : await apiGet(rpCommonName, apiKey, `/insurance/insureds/${insuredId}/status`);

      // Build reasons string from top-level nonComplianceReasons object
      const ncObj = statusRes?.nonComplianceReasons || {};
      const reasonParts = [];
      for (const [covType, reasons] of Object.entries(ncObj)) {
        if (Array.isArray(reasons) && reasons.length > 0) {
          reasonParts.push(`${covType}: ${reasons.join('; ')}`);
        }
      }
      const reasons = reasonParts.join(' | ');

      // Build decline reasons string
      const declineObj = statusRes?.declineReasons || {};
      const declineParts = [];
      for (const [covType, declines] of Object.entries(declineObj)) {
        if (Array.isArray(declines) && declines.length > 0) {
          declineParts.push(`${covType}: ${declines.join('; ')}`);
        }
      }
      const declines = declineParts.join(' | ');

      // One row per insured — no group looping, no duplicates possible
      // Skip writing a row entirely if statusRes is null (compliant/pending)
      if (!statusRes) return;
      criteriaRows.push({
        client:                  name,
        insured_id:              insuredId,
        primary_contact_email:   contactEmail,
        insured_name:            insuredName,
        overall_compliance:      statusRes?.complianceStatus || complianceStatus,
        verification_status:     verificationStatus,
        group_id:                "",
        group_name:              "",
        group_compliance:        "",
        non_compliance_reasons:  reasons,
        decline_reasons:         declines,
        sync_date:               syncDate,
        sync_timestamp:          syncTimestamp,
      });
    } catch (err) {
      errorLog.push({ client: name, stage: "criteria", insured: insuredId, error: err.message });
    }
  });

  console.log(`   ✅ ${name} — ${insuredRows.length} insureds, ${coverageRows.length} coverages, ${customPropRows.length} custom props`);

  return { insuredRows, coverageRows, customFieldRows, customPropRows, criteriaRows, summary, errorLog };
}

// ------------------------------------------------------------
// MAIN
// ------------------------------------------------------------
async function main() {
  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });

  const activeClients = CLIENTS.filter(c => {
    if (!c.apiKey) { console.warn(`⚠️  Skipping "${c.name}" — no API key`); return false; }
    return true;
  });

  console.log(`\n🚀 Processing ${activeClients.length} clients (${CLIENT_THREADS} at a time)\n`);

  const results = await pooled(activeClients, CLIENT_THREADS, processClient);

  const allInsureds    = results.flatMap(r => r?.insuredRows     || []);
  const allCoverages   = results.flatMap(r => r?.coverageRows    || []);
  const allCustFields  = results.flatMap(r => r?.customFieldRows || []);
  const allCustProps   = results.flatMap(r => r?.customPropRows  || []);
  const allCriteria    = results.flatMap(r => r?.criteriaRows    || []);
  const allErrors      = results.flatMap(r => r?.errorLog        || []);

  // Build summaries
  const syncTs   = getSyncTimestamp();
  const syncDate = getSyncDate();
  const summaryRows = activeClients.map((c, i) => {
    const s = results[i]?.summary || {};
    return {
      client:           c.name,
      total_insureds:   s.total       || 0,
      compliant:        s.compliant   || 0,
      non_compliant:    s.nonCompliant || 0,
      pending:          s.pending     || 0,
      sync_date:        syncDate,
      sync_timestamp:   syncTs,
    };
  });

  console.log("");
  const fileChanges = [
    { file: "insureds.csv",          changed: smartWrite(path.join(DATA_DIR, "insureds.csv"),          allInsureds,   "insureds.csv") },
    { file: "coverages.csv",         changed: smartWrite(path.join(DATA_DIR, "coverages.csv"),         allCoverages,  "coverages.csv") },
    { file: "custom_fields.csv",     changed: smartWrite(path.join(DATA_DIR, "custom_fields.csv"),     allCustFields, "custom_fields.csv") },
    { file: "custom_properties.csv", changed: smartWrite(path.join(DATA_DIR, "custom_properties.csv"), allCustProps,  "custom_properties.csv") },
    { file: "criteria.csv",          changed: smartWrite(path.join(DATA_DIR, "criteria.csv"),          allCriteria,   "criteria.csv") },
    { file: "summaries.csv",         changed: smartWrite(path.join(DATA_DIR, "summaries.csv"),         summaryRows,   "summaries.csv") },
  ];
  writeSyncMetadata(DATA_DIR, fileChanges, syncTs);
  console.log(`\n🕐 Sync completed: ${syncTs} CT`);

  if (allErrors.length > 0) {
    const errSummary = {};
    allErrors.forEach(e => { errSummary[e.stage] = (errSummary[e.stage] || 0) + 1; });
    console.warn(`\n⚠️  ${allErrors.length} errors: ${JSON.stringify(errSummary)}`);
    fs.writeFileSync(path.join(DATA_DIR, "sync_errors.log"), JSON.stringify(allErrors, null, 2));
  }
}

main().catch(err => {
  console.error("Fatal error:", err);
  process.exit(1);
});
