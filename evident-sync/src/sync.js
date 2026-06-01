// ============================================================
// evident-sync/src/sync.js
// Evident → CSV Sync — complete GET coverage, speed-optimised
//
// Endpoints called:
//   GET /insurance/insureds                        — paginated insured list
//   GET /insurance/insureds/export                 — bulk CSV (custom props)
//   GET /insurance/insureds/{id}/status            — NC + decline reasons (NC only)
//   GET /insurance/insureds/{id}/data              — coverage data per insured
//   GET /insurance/actions                         — outreach/action log
//   GET /insurance/config/insureds/fields          — custom field definitions
//   GET /insurance/summaries/insureds              — per-client compliance KPIs
//   GET /insurance/notifications                   — engagement/email events
//   GET /models/enums                              — platform enum definitions
//   GET /models/credentials                        — credential type list
//   GET /models/credentials/{id}                   — credential detail (once per ID)
//   GET /models/forms/categories                   — form category definitions
//
// NOTE: GET /insurance/insureds/{id} is intentionally omitted.
// The list endpoint + /export CSV already return all available
// insured fields. The per-insured detail call adds nothing new
// and would add ~13,000 extra API calls, causing a 10+ min sync.
//
// Output CSVs → data/evident/:
//   insureds.csv, coverages.csv, custom_fields.csv,
//   custom_properties.csv, criteria.csv, engagement.csv,
//   summaries.csv, actions.csv, credentials.csv,
//   enums.csv, form_categories.csv, field_definitions.csv
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
const DATA_DIR      = path.join(__dirname, "..", "..", "data", "evident");
const SNAPSHOT_BASE = path.join(__dirname, "..", "..", "snapshots");

const CLIENT_THREADS = 8;   // clients in parallel
const CONCURRENCY    = 20;  // per-insured requests per client

// ------------------------------------------------------------
// TIMESTAMPS — Central Time
// ------------------------------------------------------------
function getSyncTimestamp() {
  return new Date().toLocaleString("en-US", {
    timeZone: "America/Chicago",
    year: "numeric", month: "2-digit", day: "2-digit",
    hour: "2-digit", minute: "2-digit", second: "2-digit",
    hour12: false,
  }).replace(",", "");
}
function getSyncDate() {
  return new Date().toLocaleString("en-US", {
    timeZone: "America/Chicago",
    year: "numeric", month: "2-digit", day: "2-digit",
  });
}

// ------------------------------------------------------------
// HTTP HELPERS
// ------------------------------------------------------------
function apiGet(rpCommonName, apiKey, endpoint, params = {}) {
  return new Promise((resolve, reject) => {
    const credentials = Buffer.from(`${rpCommonName}:${apiKey}`).toString("base64");
    const qs = Object.keys(params).length
      ? "?" + Object.entries(params).map(([k, v]) => `${k}=${encodeURIComponent(v)}`).join("&")
      : "";
    https.get(`${BASE_URL}${endpoint}${qs}`, {
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
          catch (e) { reject(new Error(`JSON parse on ${endpoint}: ${e.message}`)); }
        } else {
          reject(new Error(`HTTP ${res.statusCode} on ${endpoint}: ${data.slice(0, 200)}`));
        }
      });
      stream.on("error", reject);
    }).on("error", reject);
  });
}

// Plain text GET for the /export CSV endpoint
function apiGetText(rpCommonName, apiKey, endpoint) {
  return new Promise((resolve, reject) => {
    const credentials = Buffer.from(`${rpCommonName}:${apiKey}`).toString("base64");
    https.get(`${BASE_URL}${endpoint}`, {
      headers: {
        Authorization:     `Basic ${credentials}`,
        Accept:            "text/csv",
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
        if (res.statusCode >= 200 && res.statusCode < 300) resolve(data);
        else reject(new Error(`HTTP ${res.statusCode} on ${endpoint}: ${data.slice(0, 200)}`));
      });
      stream.on("error", reject);
    }).on("error", reject);
  });
}

// ------------------------------------------------------------
// PAGINATION
// ------------------------------------------------------------
async function fetchAllInsureds(rpCommonName, apiKey) {
  const all = [];
  const limit = 100;
  let skip = 0;
  while (true) {
    const res = await apiGet(rpCommonName, apiKey, "/insurance/insureds", { limit, skip });
    if (!res) break;
    const records = res.records || [];
    all.push(...records);
    const total = res.navigation?.total ?? records.length;
    if (all.length >= total || records.length === 0) break;
    skip += limit;
  }
  return all;
}

async function fetchAllActions(rpCommonName, apiKey) {
  const all = [];
  const limit = 100;
  let skip = 0;
  while (true) {
    const res = await apiGet(rpCommonName, apiKey, "/insurance/actions", { sort: "Id", limit, skip });
    if (!res) break;
    const records = res.records || (Array.isArray(res) ? res : []);
    all.push(...records);
    const total = res.navigation?.total ?? records.length;
    if (all.length >= total || records.length === 0) break;
    skip += limit;
  }
  return all;
}

async function fetchAllCredentials(rpCommonName, apiKey) {
  const all = [];
  const limit = 100;
  let skip = 0;
  while (true) {
    const res = await apiGet(rpCommonName, apiKey, "/models/credentials", { limit, skip });
    if (!res) break;
    const records = res.records || (Array.isArray(res) ? res : []);
    all.push(...records);
    const total = res.navigation?.total ?? records.length;
    if (all.length >= total || records.length === 0) break;
    skip += limit;
  }
  return all;
}

// ------------------------------------------------------------
// RFC-4180 CSV PARSER (for /export endpoint)
// ------------------------------------------------------------
function parseCsvText(text) {
  const rows = [];
  let row = [], field = "", inQuotes = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i], next = text[i + 1];
    if (inQuotes) {
      if (ch === '"' && next === '"') { field += '"'; i++; }
      else if (ch === '"')            { inQuotes = false; }
      else                            { field += ch; }
    } else {
      if      (ch === '"')  { inQuotes = true; }
      else if (ch === ',')  { row.push(field); field = ""; }
      else if (ch === '\n' || (ch === '\r' && next === '\n')) {
        if (ch === '\r') i++;
        row.push(field); field = "";
        if (row.some(f => f !== "")) rows.push(row);
        row = [];
      } else { field += ch; }
    }
  }
  if (field || row.length) { row.push(field); if (row.some(f => f !== "")) rows.push(row); }
  return rows;
}

const STANDARD_EXPORT_FIELDS = new Set([
  "Display Name","Legal Name","DBA Name(s)","Primary Contact Email",
  "Primary Contact Name","Primary Contact Phone","Compliance Status",
  "Active","Paused","Country","Street","City","State","Zip",
  "Created At","Next Expiration",
]);

// ------------------------------------------------------------
// CONCURRENCY POOL
// ------------------------------------------------------------
async function pooled(items, limit, fn) {
  const results = [];
  let i = 0;
  async function worker() {
    while (i < items.length) { const idx = i++; results[idx] = await fn(items[idx], idx); }
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
  return [headers.join(","), ...rows.map(r => headers.map(h => csvEscape(r[h])).join(","))].join("\n");
}

// ------------------------------------------------------------
// GLOBAL REFERENCE DATA — fetched once, shared across clients
// enums, form categories, credentials (with detail)
// ------------------------------------------------------------
async function fetchGlobalData(firstClient) {
  const { rpCommonName, apiKey } = firstClient;
  const syncTimestamp = getSyncTimestamp();
  const syncDate      = getSyncDate();
  const enumRows      = [];
  const formCatRows   = [];
  const credentialRows = [];

  // GET /models/enums
  try {
    const enums = await apiGet(rpCommonName, apiKey, "/models/enums");
    if (enums && typeof enums === "object") {
      for (const [enumName, values] of Object.entries(enums)) {
        const vals = Array.isArray(values) ? values : [values];
        for (const v of vals) {
          enumRows.push({
            enum_name:      enumName,
            value:          typeof v === "object" ? JSON.stringify(v) : String(v),
            sync_date:      syncDate,
            sync_timestamp: syncTimestamp,
          });
        }
      }
    }
    console.log(`  Enums: ${enumRows.length} values`);
  } catch (err) {
    console.warn(`  ⚠️  Enums: ${err.message}`);
  }

  // GET /models/forms/categories
  try {
    const cats = await apiGet(rpCommonName, apiKey, "/models/forms/categories");
    const catList = Array.isArray(cats) ? cats : (cats?.records || cats?.categories || []);
    for (const c of catList) {
      formCatRows.push({
        id:             c.id   || "",
        name:           c.name || c.displayName || "",
        description:    c.description || "",
        form_count:     c.formCount ?? "",
        sync_date:      syncDate,
        sync_timestamp: syncTimestamp,
      });
    }
    console.log(`  Form categories: ${formCatRows.length}`);
  } catch (err) {
    console.warn(`  ⚠️  Form categories: ${err.message}`);
  }

  // GET /models/credentials (list) then GET /models/credentials/{id} (detail)
  // Done ONCE globally — credentials are platform-wide reference data,
  // not per-client. Fetching per-client would multiply calls by 17.
  try {
    const creds = await fetchAllCredentials(rpCommonName, apiKey);
    // Fetch detail for each credential in parallel (concurrency 20)
    await pooled(creds, 20, async (c) => {
      const cid = c.id || "";
      let detail = c; // fall back to list data if detail call fails
      try {
        const d = await apiGet(rpCommonName, apiKey, `/models/credentials/${cid}`);
        if (d) detail = d;
      } catch (_) { /* detail is optional enrichment */ }

      credentialRows.push({
        id:                cid,
        display_name:      detail.displayName  || c.displayName  || c.name || "",
        requirement:       detail.requirement  || c.requirement  || "",
        cred_name:         detail.name         || c.name         || "",
        country:           detail.country      || c.country      || "",
        state:             detail.state        || c.state        || "",
        county_or_region:  detail.countyOrRegion || "",
        city:              detail.city         || c.city         || "",
        issuing_authority: detail.issuingAuthority || "",
        sync_date:         syncDate,
        sync_timestamp:    syncTimestamp,
      });
    });
    console.log(`  Credentials: ${credentialRows.length}`);
  } catch (err) {
    console.warn(`  ⚠️  Credentials: ${err.message}`);
  }

  return { enumRows, formCatRows, credentialRows };
}

// ------------------------------------------------------------
// PROCESS ONE CLIENT
// ------------------------------------------------------------
async function processClient(client) {
  const { name, rpCommonName, apiKey } = client;

  const insuredRows     = [];
  const coverageRows    = [];
  const customFieldRows = [];
  const customPropRows  = [];
  const criteriaRows    = [];
  const engagementRows  = [];
  const actionRows      = [];
  const fieldDefRows    = [];
  const errorLog        = [];

  const syncTimestamp = getSyncTimestamp();
  const syncDate      = getSyncDate();

  console.log(`\n📋 Starting: ${name}`);

  // ── A. Field definitions — GET /insurance/config/insureds/fields ──
  let fieldDefs     = {};
  let fieldDefsList = [];
  try {
    const defs = await apiGet(rpCommonName, apiKey, "/insurance/config/insureds/fields");
    if (Array.isArray(defs)) {
      fieldDefsList = defs;
      for (const f of defs) {
        if (f.id) fieldDefs[f.id] = { id: f.id, name: f.name || f.id, key: f.key || f.id };
        fieldDefRows.push({
          client:         name,
          field_id:       f.id   || "",
          field_name:     f.name || "",
          field_key:      f.key  || "",
          field_type:     f.type || "",
          required:       f.required ?? "",
          sync_date:      syncDate,
          sync_timestamp: syncTimestamp,
        });
      }
    }
    console.log(`   Field defs: ${fieldDefsList.length}`);
  } catch (err) {
    errorLog.push({ client: name, stage: "field_defs", error: err.message });
  }

  // ── B. Bulk export — GET /insurance/insureds/export ──────────────
  // One call captures ALL custom property values for ALL insureds.
  // This is the primary source for custom props — fast and complete.
  let exportCustomProps = {}; // insuredName.toLowerCase() → [{fieldName, fieldValue}]
  try {
    const csvText = await apiGetText(rpCommonName, apiKey, "/insurance/insureds/export");
    if (csvText?.trim()) {
      const rows    = parseCsvText(csvText);
      const headers = rows[0] || [];
      const customCols = headers
        .map((h, i) => ({ name: h.trim(), index: i }))
        .filter(({ name }) => !STANDARD_EXPORT_FIELDS.has(name));
      const nameIdx  = headers.findIndex(h => h.trim() === "Display Name");
      const emailIdx = headers.findIndex(h => h.trim() === "Primary Contact Email");
      for (const row of rows.slice(1)) {
        const insuredName  = nameIdx  >= 0 ? (row[nameIdx]  || "").trim() : "";
        const contactEmail = emailIdx >= 0 ? (row[emailIdx] || "").trim() : "";
        const key = insuredName.toLowerCase();
        if (!exportCustomProps[key]) exportCustomProps[key] = { insuredName, contactEmail, props: [] };
        for (const { name: fieldName, index } of customCols) {
          const fieldValue = (row[index] || "").trim();
          if (fieldValue) exportCustomProps[key].props.push({ fieldName, fieldValue });
        }
      }
      console.log(`   Export CSV: ${rows.length - 1} rows, ${customCols.length} custom columns`);
    }
  } catch (err) {
    errorLog.push({ client: name, stage: "export_csv", error: err.message });
  }

  // ── C. Actions — GET /insurance/actions ──────────────────────────
  try {
    const actions = await fetchAllActions(rpCommonName, apiKey);
    for (const a of actions) {
      actionRows.push({
        client:         name,
        action_id:      a.id           || "",
        action_type:    a.type         || a.actionType || "",
        insured_id:     a.insuredId    || a.insured_id || "",
        insured_name:   a.insuredName  || a.displayName || "",
        status:         a.status       || "",
        created_at:     a.createdAt    || a.created_at  || "",
        updated_at:     a.updatedAt    || a.updated_at  || "",
        scheduled_at:   a.scheduledAt  || "",
        completed_at:   a.completedAt  || "",
        notes:          a.notes        || a.description || "",
        triggered_by:   a.triggeredBy  || a.createdBy   || "",
        sync_date:      syncDate,
        sync_timestamp: syncTimestamp,
      });
    }
    console.log(`   Actions: ${actionRows.length}`);
  } catch (err) {
    errorLog.push({ client: name, stage: "actions", error: err.message });
  }

  // ── D. Insureds — GET /insurance/insureds (paginated list) ───────
  let insureds = [];
  try {
    insureds = await fetchAllInsureds(rpCommonName, apiKey);
    console.log(`   Insureds: ${insureds.length}`);
  } catch (err) {
    errorLog.push({ client: name, stage: "insureds", error: err.message });
    return { insuredRows, coverageRows, customFieldRows, customPropRows,
             criteriaRows, engagementRows, actionRows, fieldDefRows, errorLog };
  }

  // ── E. Summary — GET /insurance/summaries/insureds ───────────────
  let summary = { compliant: 0, nonCompliant: 0, pending: 0, total: insureds.length };
  try {
    const s = await apiGet(rpCommonName, apiKey, "/insurance/summaries/insureds");
    if (s) {
      summary.compliant    = s.compliantCount    ?? s.compliant    ?? s.statistics?.compliantCount    ?? 0;
      summary.nonCompliant = s.nonCompliantCount ?? s.nonCompliant ?? s.statistics?.nonCompliantCount ?? 0;
      summary.pending      = s.pendingCount      ?? s.pending      ?? s.statistics?.pendingCount      ?? 0;
    }
  } catch (_) {
    for (const ins of insureds) {
      const st = (ins.complianceStatus || ins.status || "").toUpperCase();
      if      (st === "COMPLIANT") summary.compliant++;
      else if (st === "PENDING")   summary.pending++;
      else                         summary.nonCompliant++;
    }
  }

  // ── F. Engagement — GET /insurance/notifications ─────────────────
  try {
    const res = await apiGet(rpCommonName, apiKey, "/insurance/notifications");
    const events = Array.isArray(res) ? res : (res?.records || []);
    for (const ev of events) {
      engagementRows.push({
        Client:         name,
        Email:          ev.email       || ev.recipientEmail || "",
        Type:           ev.type        || ev.eventType      || "",
        Date:           ev.sentAt      || ev.createdAt      || ev.timestamp || "",
        Subject:        ev.subject     || ev.emailSubject   || "",
        insured_id:     ev.insuredId   || ev.insured_id     || "",
        sync_date:      syncDate,
        sync_timestamp: syncTimestamp,
      });
    }
    if (events.length) console.log(`   Engagement events: ${events.length}`);
  } catch (err) {
    errorLog.push({ client: name, stage: "engagement", error: err.message });
  }

  // ── G. Per-insured: build rows + coverage data + criteria ─────────
  // API calls per insured: /data (always) + /status (NC only)
  // No /insureds/{id} call — list already has everything we need.
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
      country:               address.country || insured.country || "",
      city:                  address.city    || insured.city    || "",
      state:                 address.state   || insured.state   || "",
      sync_date:             syncDate,
      sync_timestamp:        syncTimestamp,
    });

    // Custom properties from the list response (properties / customProperties / insuredFields)
    let propList = [];
    if      (Array.isArray(insured.properties)       && insured.properties.length)       propList = insured.properties;
    else if (Array.isArray(insured.customProperties) && insured.customProperties.length) propList = insured.customProperties;

    for (const prop of propList) {
      const fieldId    = prop.field?.id   || prop.fieldId   || prop.id   || "";
      const fieldName  = prop.field?.name || prop.fieldName || prop.name ||
                         fieldDefs[fieldId]?.name || fieldId || "";
      const rawValue   = prop.value !== undefined ? prop.value : prop.fieldValue;
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
        source:         "api_list",
        sync_date:      syncDate,
        sync_timestamp: syncTimestamp,
      });
    }

    // Positional insuredFields array
    const insuredFieldsArr = Array.isArray(insured.insuredFields) ? insured.insuredFields : [];
    insuredFieldsArr.forEach((fieldVal, i) => {
      if (fieldVal === null || fieldVal === undefined) return;
      const fieldDef   = fieldDefsList[i] || {};
      const fieldName  = fieldDef.name || fieldDef.key || `field_${i}`;
      const fieldKey   = fieldDef.key  || fieldDef.id  || `field_${i}`;
      const fieldValue = typeof fieldVal === "object" ? JSON.stringify(fieldVal) : String(fieldVal);
      if (!fieldValue.trim()) return;
      customPropRows.push({
        client:         name,
        insured_id:     insuredId,
        insured_name:   insuredName,
        field_id:       fieldKey,
        field_name:     fieldName,
        field_value:    fieldValue,
        source:         "insured_fields",
        sync_date:      syncDate,
        sync_timestamp: syncTimestamp,
      });
    });

    // Export CSV custom columns — de-duplicate against what list already provided
    const exportKey = insuredName.toLowerCase();
    if (exportCustomProps[exportKey]) {
      const existingNames = new Set(customPropRows
        .filter(r => r.insured_id === insuredId)
        .map(r => r.field_name));
      for (const { fieldName, fieldValue } of exportCustomProps[exportKey].props) {
        if (!existingNames.has(fieldName)) {
          customPropRows.push({
            client:         name,
            insured_id:     insuredId,
            insured_name:   insuredName,
            field_id:       "",
            field_name:     fieldName,
            field_value:    fieldValue,
            source:         "export_csv",
            sync_date:      syncDate,
            sync_timestamp: syncTimestamp,
          });
        }
      }
    }

    // ── GET /insurance/insureds/{id}/data — coverage data ─────────
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
            coverage_id:           covData.coverageId    || "",
            policy_number:         policy.policyNumber   || "",
            insurer:               policy.carrier?.name  || "",
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

    // ── GET /insurance/insureds/{id}/status — NC reasons ──────────
    // Skip COMPLIANT / PENDING / NEW — they have no NC reasons.
    // Saves ~33% of all /status calls.
    const skipStatus = ["COMPLIANT", "PENDING", "NEW"].includes(
      (complianceStatus || "").toUpperCase()
    );
    try {
      const statusRes = skipStatus
        ? null
        : await apiGet(rpCommonName, apiKey, `/insurance/insureds/${insuredId}/status`);
      if (!statusRes) return;

      const ncObj = statusRes?.nonComplianceReasons || {};
      const reasonParts = [];
      for (const [covType, reasons] of Object.entries(ncObj)) {
        if (Array.isArray(reasons) && reasons.length > 0)
          reasonParts.push(`${covType}: ${reasons.join("; ")}`);
      }

      const declineObj = statusRes?.declineReasons || {};
      const declineParts = [];
      for (const [covType, declines] of Object.entries(declineObj)) {
        if (Array.isArray(declines) && declines.length > 0)
          declineParts.push(`${covType}: ${declines.join("; ")}`);
      }

      criteriaRows.push({
        client:                 name,
        insured_id:             insuredId,
        primary_contact_email:  contactEmail,
        insured_name:           insuredName,
        overall_compliance:     statusRes?.complianceStatus || complianceStatus,
        verification_status:    verificationStatus,
        group_id:               "",
        group_name:             "",
        group_compliance:       "",
        non_compliance_reasons: reasonParts.join(" | "),
        decline_reasons:        declineParts.join(" | "),
        sync_date:              syncDate,
        sync_timestamp:         syncTimestamp,
      });
    } catch (err) {
      errorLog.push({ client: name, stage: "criteria", insured: insuredId, error: err.message });
    }
  });

  console.log(`   ✅ ${name} — ${insuredRows.length} insureds, ${coverageRows.length} coverages, ${customPropRows.length} custom props, ${criteriaRows.length} criteria, ${actionRows.length} actions`);

  return {
    insuredRows, coverageRows, customFieldRows, customPropRows,
    criteriaRows, engagementRows, actionRows, fieldDefRows,
    summary, errorLog,
  };
}

// ------------------------------------------------------------
// SNAPSHOT HELPER — monthly + daily, every run
// ------------------------------------------------------------
function writeSnapshots(allInsureds, allCriteria, allEngagement) {
  const now   = new Date();
  const yyyy  = now.getUTCFullYear().toString();
  const mm    = String(now.getUTCMonth() + 1).padStart(2, "0");
  const dd    = String(now.getUTCDate()).padStart(2, "0");
  const month = `${yyyy}-${mm}`;
  const day   = `${yyyy}-${mm}-${dd}`;

  const files = [
    { name: "insureds.csv",   rows: allInsureds },
    { name: "criteria.csv",   rows: allCriteria },
    { name: "engagement.csv", rows: allEngagement },
  ];

  // Monthly — snapshots/YYYY/YYYY-MM/ (overwritten each run = always freshest)
  const monthlyDir = path.join(SNAPSHOT_BASE, yyyy, month);
  fs.mkdirSync(monthlyDir, { recursive: true });
  for (const { name, rows } of files)
    fs.writeFileSync(path.join(monthlyDir, name), toCsv(rows), "utf8");
  console.log(`\n📅 Monthly snapshot → snapshots/${yyyy}/${month}/`);

  // Daily — snapshots/daily/YYYY/YYYY-MM-DD/ (Date Range mode)
  const dailyDir = path.join(SNAPSHOT_BASE, "daily", yyyy, day);
  fs.mkdirSync(dailyDir, { recursive: true });
  for (const { name, rows } of files)
    fs.writeFileSync(path.join(dailyDir, name), toCsv(rows), "utf8");
  console.log(`📅 Daily snapshot   → snapshots/daily/${yyyy}/${day}/`);
}

// ------------------------------------------------------------
// MAIN
// ------------------------------------------------------------
async function main() {
  fs.mkdirSync(DATA_DIR, { recursive: true });

  const activeClients = CLIENTS.filter(c => {
    if (!c.apiKey) { console.warn(`⚠️  Skipping "${c.name}" — no API key`); return false; }
    return true;
  });

  console.log(`\n🚀 Processing ${activeClients.length} clients (${CLIENT_THREADS} at a time)\n`);

  // Global reference data — fetched ONCE using the first client's credentials
  console.log("Fetching global reference data (enums, credentials, form categories)...");
  const { enumRows, formCatRows, credentialRows } = await fetchGlobalData(activeClients[0]);

  // All clients in parallel
  const results = await pooled(activeClients, CLIENT_THREADS, processClient);

  const allInsureds   = results.flatMap(r => r?.insuredRows     || []);
  const allCoverages  = results.flatMap(r => r?.coverageRows    || []);
  const allCustFields = results.flatMap(r => r?.customFieldRows || []);
  const allCustProps  = results.flatMap(r => r?.customPropRows  || []);
  const allCriteria   = results.flatMap(r => r?.criteriaRows    || []);
  const allEngagement = results.flatMap(r => r?.engagementRows  || []);
  const allActions    = results.flatMap(r => r?.actionRows      || []);
  const allFieldDefs  = results.flatMap(r => r?.fieldDefRows    || []);
  const allErrors     = results.flatMap(r => r?.errorLog        || []);

  const syncTs   = getSyncTimestamp();
  const syncDate = getSyncDate();

  const summaryRows = activeClients.map((c, i) => {
    const s = results[i]?.summary || {};
    return {
      client:         c.name,
      total_insureds: s.total        || 0,
      compliant:      s.compliant    || 0,
      non_compliant:  s.nonCompliant || 0,
      pending:        s.pending      || 0,
      sync_date:      syncDate,
      sync_timestamp: syncTs,
    };
  });

  console.log("\n");
  const fileChanges = [
    { file: "insureds.csv",          changed: smartWrite(path.join(DATA_DIR, "insureds.csv"),          allInsureds,    "insureds.csv") },
    { file: "coverages.csv",         changed: smartWrite(path.join(DATA_DIR, "coverages.csv"),         allCoverages,   "coverages.csv") },
    { file: "custom_fields.csv",     changed: smartWrite(path.join(DATA_DIR, "custom_fields.csv"),     allCustFields,  "custom_fields.csv") },
    { file: "custom_properties.csv", changed: smartWrite(path.join(DATA_DIR, "custom_properties.csv"), allCustProps,   "custom_properties.csv") },
    { file: "criteria.csv",          changed: smartWrite(path.join(DATA_DIR, "criteria.csv"),          allCriteria,    "criteria.csv") },
    { file: "engagement.csv",        changed: smartWrite(path.join(DATA_DIR, "engagement.csv"),        allEngagement,  "engagement.csv") },
    { file: "summaries.csv",         changed: smartWrite(path.join(DATA_DIR, "summaries.csv"),         summaryRows,    "summaries.csv") },
    { file: "actions.csv",           changed: smartWrite(path.join(DATA_DIR, "actions.csv"),           allActions,     "actions.csv") },
    { file: "credentials.csv",       changed: smartWrite(path.join(DATA_DIR, "credentials.csv"),       credentialRows, "credentials.csv") },
    { file: "enums.csv",             changed: smartWrite(path.join(DATA_DIR, "enums.csv"),             enumRows,       "enums.csv") },
    { file: "form_categories.csv",   changed: smartWrite(path.join(DATA_DIR, "form_categories.csv"),   formCatRows,    "form_categories.csv") },
    { file: "field_definitions.csv", changed: smartWrite(path.join(DATA_DIR, "field_definitions.csv"), allFieldDefs,   "field_definitions.csv") },
  ];

  writeSyncMetadata(DATA_DIR, fileChanges, syncTs);
  writeSnapshots(allInsureds, allCriteria, allEngagement);

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
