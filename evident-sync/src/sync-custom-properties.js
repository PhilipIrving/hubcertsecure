// ============================================================
// Evident → Custom Properties Sync
// Uses GET /insurance/insureds/export — returns a CSV with
// common fields + all RP custom insured fields in ONE call
// per client (17 total vs 13,000 individual fetches).
//
// Output: data/custom_properties.csv
// ============================================================

"use strict";

const https = require("https");
const zlib  = require("zlib");
const fs    = require("fs");
const path  = require("path");
const { smartWrite, writeSyncMetadata } = require("./sync-utils");

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

const BASE_URL = "https://verify.api.evidentid.com/api/v1";
const DATA_DIR = path.join(__dirname, "..", "data");

// Standard columns present in every export — everything after these is a custom property
const STANDARD_FIELDS = new Set([
  "Display Name","Legal Name","DBA Name(s)","Primary Contact Email",
  "Primary Contact Name","Primary Contact Phone","Compliance Status",
  "Active","Paused","Country","Street","City","State","Zip",
  "Created At","Next Expiration",
]);

function getSyncTimestamp() {
  return new Date().toLocaleString("en-US", {
    timeZone:"America/Chicago", year:"numeric", month:"2-digit", day:"2-digit",
    hour:"2-digit", minute:"2-digit", second:"2-digit", hour12:false,
  }).replace(",","");
}
function getSyncDate() {
  return new Date().toLocaleString("en-US", {
    timeZone:"America/Chicago", year:"numeric", month:"2-digit", day:"2-digit",
  });
}

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
        if (res.statusCode >= 200 && res.statusCode < 300) { resolve(data); }
        else reject(new Error(`HTTP ${res.statusCode}: ${data.slice(0,200)}`));
      });
      stream.on("error", reject);
    }).on("error", reject);
  });
}

// RFC-4180 CSV parser — handles quoted fields, embedded commas and newlines
function parseCsv(text) {
  const rows = [];
  let row = [], field = "", inQuotes = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i], next = text[i+1];
    if (inQuotes) {
      if (ch==='"' && next==='"') { field+='"'; i++; }
      else if (ch==='"')          { inQuotes=false; }
      else                        { field+=ch; }
    } else {
      if      (ch==='"')          { inQuotes=true; }
      else if (ch===',')          { row.push(field); field=""; }
      else if (ch==='\n' || (ch==='\r' && next==='\n')) {
        if (ch==='\r') i++;
        row.push(field); field="";
        if (row.some(f=>f!=="")) rows.push(row);
        row=[];
      } else { field+=ch; }
    }
  }
  if (field || row.length) { row.push(field); if (row.some(f=>f!=="")) rows.push(row); }
  return rows;
}

function csvEscape(v) {
  if (v===null||v===undefined) return "";
  const s=String(v);
  return (s.includes(",")||s.includes('"')||s.includes("\n")) ? `"${s.replace(/"/g,'""')}"` : s;
}
function toCsv(rows) {
  if (!rows||rows.length===0) return "";
  const h=Object.keys(rows[0]);
  return [h.join(","), ...rows.map(r=>h.map(k=>csvEscape(r[k])).join(","))].join("\n");
}

async function processClient(client) {
  const { name, rpCommonName, apiKey } = client;
  const customPropRows = [];
  const syncTimestamp  = getSyncTimestamp();
  const syncDate       = getSyncDate();
  console.log(`\n📋 ${name}`);

  try {
    const csvText = await apiGetText(rpCommonName, apiKey, "/insurance/insureds/export");
    if (!csvText?.trim()) { console.log(`   ⚠️  Empty response`); return { customPropRows }; }

    const rows = parseCsv(csvText);
    if (rows.length < 2) { console.log(`   ⚠️  No data rows`); return { customPropRows }; }

    const headers  = rows[0];
    const dataRows = rows.slice(1);

    // Columns that are custom properties (everything not in STANDARD_FIELDS)
    const customCols = headers
      .map((h,i) => ({ name:h.trim(), index:i }))
      .filter(({ name }) => !STANDARD_FIELDS.has(name));

    const nameIdx  = headers.findIndex(h => h.trim()==="Display Name");
    const emailIdx = headers.findIndex(h => h.trim()==="Primary Contact Email");

    console.log(`   ${headers.length} columns | ${customCols.length} custom: ${customCols.map(c=>c.name).join(", ") || "none"}`);

    let populated = 0;
    for (const row of dataRows) {
      const insuredName  = nameIdx  >= 0 ? (row[nameIdx]  ||"").trim() : "";
      const contactEmail = emailIdx >= 0 ? (row[emailIdx] ||"").trim() : "";
      let hasData = false;

      for (const { name:fieldName, index } of customCols) {
        const fieldValue = (row[index]||"").trim();
        if (!fieldValue) continue;
        hasData = true;
        customPropRows.push({
          client:         name,
          insured_name:   insuredName,
          contact_email:  contactEmail,
          field_name:     fieldName,
          field_value:    fieldValue,
          sync_date:      syncDate,
          sync_timestamp: syncTimestamp,
        });
      }
      if (hasData) populated++;
    }

    console.log(`   ✅ ${populated} of ${dataRows.length} insureds have custom properties (${customPropRows.length} rows)`);
  } catch (err) {
    console.error(`   ❌ ${err.message}`);
  }
  return { customPropRows };
}

async function main() {
  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });

  const active = CLIENTS.filter(c => {
    if (!c.apiKey) { console.warn(`⚠️  Skipping "${c.name}" — no API key`); return false; }
    return true;
  });

  console.log(`\n🔍 Custom Properties Sync — ${active.length} clients via /export (17 API calls)\n`);

  // All 17 clients in parallel — it's just one call each
  const results = await Promise.all(active.map(processClient));
  const allProps = results.flatMap(r => r?.customPropRows || []);

  const syncTs = getSyncTimestamp();
  console.log("");
  const changed = smartWrite(path.join(DATA_DIR, "custom_properties.csv"), allProps, "custom_properties.csv");
  writeSyncMetadata(DATA_DIR, [{ file: "custom_properties.csv", changed }], syncTs);
  console.log(`🕐 Sync completed: ${syncTs} CT`);
}

main().catch(err => { console.error("Fatal error:", err); process.exit(1); });
