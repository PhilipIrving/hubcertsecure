// ============================================================
// TrustLayer → Evident-compatible CSV Transform
//
// Reads (from /data/):
//   vendors.csv           — vendor master with status + email
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

  const vendors       = readCsv("vendors.csv");
  const requestRecs   = readCsv("request_records.csv");
  const covSubjects   = readCsv("coverage_subjects.csv");
  const requirements  = readCsv("requirements.csv");

  console.log(`  vendors:           ${vendors.length} rows`);
  console.log(`  request_records:   ${requestRecs.length} rows`);
  console.log(`  coverage_subjects: ${covSubjects.length} rows`);
  console.log(`  requirements:      ${requirements.length} rows`);

  // vendorMap: vendor_id → {client, name, email, active}
  const vendorMap = {};
  for (const v of vendors) {
    vendorMap[v.vendor_id] = {
      client: v.client,
      name:   v.vendor_name,
      email:  v.email || "",
      active: (v.status || "").toLowerCase() === "active",
    };
  }

  // requestsByVendor: vendor_id → [request rows]
  const requestsByVendor = {};
  for (const r of requestRecs) {
    if (!requestsByVendor[r.vendor_id]) requestsByVendor[r.vendor_id] = [];
    requestsByVendor[r.vendor_id].push(r);
  }

  // subjectsByRequest: request_id → [subject rows]
  const subjectsByRequest = {};
  for (const s of covSubjects) {
    if (!subjectsByRequest[s.request_id]) subjectsByRequest[s.request_id] = [];
    subjectsByRequest[s.request_id].push(s);
  }

  // Non-compliance reasons per vendor — format: "SUBJECT: attribute | SUBJECT: attribute"
  // space-pipe-space delimiter matches the Evident report script parser
  const reasonsByVendor = {};
  for (const r of requirements) {
    if (normStatus(r.status) !== "NON_COMPLIANT") continue;
    const vid   = r.vendor_id;
    const subj  = (r.subject_label  || "").toUpperCase();
    const attr  = r.attribute_label || "";
    if (subj && attr) {
      if (!reasonsByVendor[vid]) reasonsByVendor[vid] = new Set();
      reasonsByVendor[vid].add(`${subj}: ${attr}`);
    }
  }

  // ── insureds.csv ───────────────────────────────────────────
  const insuredRows = [];
  for (const v of vendors) {
    const vid      = v.vendor_id;
    const requests = requestsByVendor[vid] || [];

    const compStatus = requests.length
      ? worstStatus(requests.map(r => r.compliance_status))
      : "PENDING";

    const nextExp = earliestDate(
      requests.map(r => r.cert_expiration).filter(Boolean)
    );

    insuredRows.push({
      client:               v.client,
      insured_id:           vid,
      insured_name:         v.vendor_name,
      primary_contact_email: v.email || "",
      compliance_status:    compStatus,
      verification_status:  "",
      next_expiration:      nextExp,
      active:               (v.status || "").toLowerCase() === "active",
      paused:               false,
      sync_date:            TODAY,
    });
  }

  // ── coverages.csv ─────────────────────────────────────────
  const coverageRows = [];
  for (const s of covSubjects) {
    const vinfo = vendorMap[s.vendor_id] || {};
    coverageRows.push({
      client:                v_client(s, vinfo),
      insured_id:            s.vendor_id,
      insured_name:          s.vendor_name,
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
    const vid      = v.vendor_id;
    const requests = requestsByVendor[vid] || [];

    const overallCompliance = requests.length
      ? worstStatus(requests.map(r => r.compliance_status))
      : "PENDING";

    // space-pipe-space delimiter — matches .split(" | ") in report scripts
    const reasons = reasonsByVendor[vid]
      ? Array.from(reasonsByVendor[vid]).join(" | ")
      : "";

    criteriaRows.push({
      client:               v.client,
      insured_id:           vid,
      insured_name:         v.vendor_name,
      primary_contact_email: v.email || "",
      overall_compliance:   overallCompliance,
      verification_status:  "",
      non_compliance_reasons: reasons,
      sync_date:            TODAY,
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

// Helper: prefer client from coverage subject row, fall back to vendorMap
function v_client(s, vinfo) {
  return s.client || vinfo.client || "";
}

main();
