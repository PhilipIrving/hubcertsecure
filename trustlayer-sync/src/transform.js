// ============================================================
// TrustLayer → Evident-compatible CSV Transform
//
// Reads (from /data/):
//   vendors.csv           — vendor master (columns: client, id, name, primary_email, status)
//   request_records.csv   — compliance status + cert expiration
//   coverage_subjects.csv — per-subject coverage status + dates
//   requirements.csv      — per-attribute requirements + actual values
//
// Writes (to /data/):
//   insureds.csv   — one row per vendor
//   coverages.csv  — one row per coverage subject
//   criteria.csv   — one row per vendor with pipe-delimited non-compliance reasons
//
// non_compliance_reasons format: "SUBJECT: reason | SUBJECT: reason"
// (space-pipe-space delimiter matches the Evident report script parser)
//
// Status: compliant → COMPLIANT, non_compliant → NON_COMPLIANT
// Active: vendors.status == "active" → True, paused always False
// ============================================================

const fs   = require("fs");
const path = require("path");

const DATA_DIR = path.join(__dirname, "..", "data");
const TODAY    = new Date().toISOString().split("T")[0];

// ------------------------------------------------------------
// CSV PARSER — handles quoted fields with embedded commas/newlines
// ------------------------------------------------------------
function parseRow(line) {
  const fields = [];
  let cur = "";
  let inQ = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (ch === '"') {
      if (inQ && line[i + 1] === '"') { cur += '"'; i++; }
      else inQ = !inQ;
    } else if (ch === "," && !inQ) {
      fields.push(cur); cur = "";
    } else { cur += ch; }
  }
  fields.push(cur);
  return fields;
}

function parseCsv(content) {
  const raw = content.replace(/\r\n/g, "\n").replace(/\r/g, "\n").trim();
  if (!raw) return [];
  const lines = [];
  let cur = "";
  let inQ = false;
  for (let i = 0; i < raw.length; i++) {
    const ch = raw[i];
    if (ch === '"') {
      if (inQ && raw[i + 1] === '"') { cur += '""'; i++; }
      else { inQ = !inQ; cur += ch; }
    } else if (ch === "\n" && !inQ) {
      lines.push(cur); cur = "";
    } else { cur += ch; }
  }
  if (cur) lines.push(cur);
  if (lines.length < 2) return [];
  const headers = parseRow(lines[0]);
  return lines.slice(1).filter(l => l.trim()).map(line => {
    const vals = parseRow(line);
    const obj  = {};
    headers.forEach((h, i) => { obj[h] = vals[i] !== undefined ? vals[i] : ""; });
    return obj;
  });
}

function readCsv(filename) {
  const fp = path.join(DATA_DIR, filename);
  if (!fs.existsSync(fp)) { console.warn(`  ⚠️  Missing: ${filename}`); return []; }
  return parseCsv(fs.readFileSync(fp, "utf8"));
}

// ------------------------------------------------------------
// CSV WRITER
// ------------------------------------------------------------
function esc(v) {
  if (v === null || v === undefined) return "";
  const s = String(v);
  return (s.includes(",") || s.includes('"') || s.includes("\n"))
    ? `"${s.replace(/"/g, '""')}"` : s;
}
function toCsv(rows) {
  if (!rows?.length) return "";
  const h = Object.keys(rows[0]);
  return [h.join(","), ...rows.map(r => h.map(k => esc(r[k])).join(","))].join("\n");
}

// ------------------------------------------------------------
// STATUS HELPERS
// ------------------------------------------------------------
function normStatus(s) {
  if (!s) return "PENDING";
  const u = s.toUpperCase().replace(/-/g, "_");
  if (u === "COMPLIANT")     return "COMPLIANT";
  if (u === "NON_COMPLIANT") return "NON_COMPLIANT";
  return "PENDING";
}

function worstStatus(statuses) {
  const n = statuses.map(normStatus);
  if (n.includes("NON_COMPLIANT")) return "NON_COMPLIANT";
  if (n.includes("PENDING"))       return "PENDING";
  if (n.includes("COMPLIANT"))     return "COMPLIANT";
  return "PENDING";
}

function earliestDate(dates) {
  const valid = dates.filter(d => d && d.trim());
  return valid.length ? valid.sort()[0] : "";
}

// ------------------------------------------------------------
// MAIN
// ------------------------------------------------------------
function main() {
  console.log("\n🔄 TrustLayer transform starting...");

  const vendors      = readCsv("vendors.csv");
  const requestRecs  = readCsv("request_records.csv");
  const covSubjects  = readCsv("coverage_subjects.csv");
  const requirements = readCsv("requirements.csv");

  console.log(`  vendors:           ${vendors.length} rows`);
  console.log(`  request_records:   ${requestRecs.length} rows`);
  console.log(`  coverage_subjects: ${covSubjects.length} rows`);
  console.log(`  requirements:      ${requirements.length} rows`);

  // ── Column name normaliser ─────────────────────────────────
  // sync.js outputs: id, name, primary_email
  // support both old column names (vendor_id, vendor_name, email)
  // and new ones so the transform works regardless of which
  // version of sync.js produced the file.
  function vid(v)   { return v.id           || v.vendor_id    || ""; }
  function vname(v) { return v.name         || v.vendor_name  || ""; }
  function vemail(v){ return v.primary_email || v.email       || ""; }
  function vclient(v){ return v.client || ""; }

  // vendorMap: vendor_id → { client, name, email, active }
  const vendorMap = {};
  for (const v of vendors) {
    vendorMap[vid(v)] = {
      client: vclient(v),
      name:   vname(v),
      email:  vemail(v),
      active: (v.status || "").toLowerCase() === "active",
    };
  }

  // requestsByVendor: vendor_id → [request rows]
  const requestsByVendor = {};
  for (const r of requestRecs) {
    const key = r.vendor_id || "";
    if (!requestsByVendor[key]) requestsByVendor[key] = [];
    requestsByVendor[key].push(r);
  }

  // Non-compliance reasons per vendor
  // format: "SUBJECT: attribute | SUBJECT: attribute"
  // space-pipe-space matches .split(" | ") in report scripts
  const reasonsByVendor = {};
  for (const r of requirements) {
    if (normStatus(r.status) !== "NON_COMPLIANT") continue;
    const key  = r.vendor_id || "";
    const subj = (r.subject_label  || "").toUpperCase();
    const attr = r.attribute_label || "";
    if (subj && attr) {
      if (!reasonsByVendor[key]) reasonsByVendor[key] = new Set();
      reasonsByVendor[key].add(`${subj}: ${attr}`);
    }
  }

  // ── insureds.csv ───────────────────────────────────────────
  const insuredRows = [];
  for (const v of vendors) {
    const id       = vid(v);
    const requests = requestsByVendor[id] || [];

    const compStatus = requests.length
      ? worstStatus(requests.map(r => r.compliance_status))
      : "PENDING";

    const nextExp = earliestDate(
      requests.map(r => r.cert_expiration).filter(Boolean)
    );

    insuredRows.push({
      client:                vclient(v),
      insured_id:            id,
      insured_name:          vname(v),
      primary_contact_email: vemail(v),
      compliance_status:     compStatus,
      verification_status:   "",
      next_expiration:       nextExp,
      active:                (v.status || "").toLowerCase() === "active",
      paused:                false,
      sync_date:             TODAY,
    });
  }

  // ── coverages.csv ─────────────────────────────────────────
  const coverageRows = [];
  for (const s of covSubjects) {
    const vinfo = vendorMap[s.vendor_id] || {};
    coverageRows.push({
      client:                s.client || vinfo.client || "",
      insured_id:            s.vendor_id || "",
      insured_name:          s.vendor_name || vinfo.name || "",
      primary_contact_email: vinfo.email || "",
      coverage_type:         s.subject_label  || "",
      coverage_id:           s.subject_code   || "",
      policy_number:         "",
      insurer:               "",
      effective_date:        s.effective_date  || "",
      expiration_date:       s.expiration_date || "",
      per_occurrence:        "",
      aggregate:             "",
      combined_single_limit: "",
      created_at:            "",
      sync_date:             TODAY,
    });
  }

  // ── criteria.csv ──────────────────────────────────────────
  const criteriaRows = [];
  for (const v of vendors) {
    const id       = vid(v);
    const requests = requestsByVendor[id] || [];

    const overallCompliance = requests.length
      ? worstStatus(requests.map(r => r.compliance_status))
      : "PENDING";

    const reasons = reasonsByVendor[id]
      ? Array.from(reasonsByVendor[id]).join(" | ")
      : "";

    criteriaRows.push({
      client:                vclient(v),
      insured_id:            id,
      insured_name:          vname(v),
      primary_contact_email: vemail(v),
      overall_compliance:    overallCompliance,
      verification_status:   "",
      non_compliance_reasons: reasons,
      sync_date:             TODAY,
    });
  }

  fs.writeFileSync(path.join(DATA_DIR, "insureds.csv"),  toCsv(insuredRows));
  fs.writeFileSync(path.join(DATA_DIR, "coverages.csv"), toCsv(coverageRows));
  fs.writeFileSync(path.join(DATA_DIR, "criteria.csv"),  toCsv(criteriaRows));

  console.log(`\n✅ insureds.csv  — ${insuredRows.length} rows`);
  console.log(`✅ coverages.csv — ${coverageRows.length} rows`);
  console.log(`✅ criteria.csv  — ${criteriaRows.length} rows`);
  console.log("\n✅ Transform complete.\n");
}

main();
