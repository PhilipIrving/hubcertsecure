// ============================================================
// TrustLayer v2 → CSV Sync Script
// Full coverage of all useful GET endpoints per OpenAPI spec
//
// Endpoints used:
//   GET /context-objects          → project type definitions (1 call)
//   GET /context-records          → all projects with names/dates (1 call)
//   GET /primary-objects          → vendor type definitions (1 call)
//   GET /primary-records          → all vendors with contacts/address
//   GET /primary-records/{id}/contacts → full contact list per vendor
//   GET /request-records          → all compliance records with full modules
//   GET /request-records/{id}/compliance-certificate → cert URL, flag, status
//
// Skipped (per spec analysis):
//   /primary-records/{id}/attributes   → returns {value, optionIds} with no
//   /request-records/{id}/attributes     label — not useful without definitions
//   /policies/{number}               → requires policy number as input
//   /views                           → UI saved filters, not data
//
// Output files (written to /data/):
//   vendors.csv          — vendors with address, all contacts, computed attrs
//   contacts.csv         — all contacts per vendor (one row per contact)
//   context_records.csv  — all projects with type, status, dates
//   request_records.csv  — vendor+project compliance with cert info
//   coverage_subjects.csv — one row per coverage subject (expiry, validity)
//   requirements.csv     — most granular: actual vs required per attribute
// ============================================================

const https = require("https");
const fs    = require("fs");
const path  = require("path");

const CLIENTS = [
  { name: "Block Real Estate",     token: process.env.TL_TOKEN_BLOCK_REAL_ESTATE },
  { name: "Construction Mgmt Inc", token: process.env.TL_TOKEN_CMI },
];

const BASE_URL = "https://api.trustlayer.io/v2";
const DATA_DIR = path.join(__dirname, "..", "data");

// ------------------------------------------------------------
// HTTP HELPER
// ------------------------------------------------------------
function apiGet(token, endpoint, params = {}) {
  return new Promise((resolve, reject) => {
    const qs = Object.keys(params).length
      ? "?" + Object.entries(params)
          .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`)
          .join("&")
      : "";
    const url = `${BASE_URL}${endpoint}${qs}`;

    https.get(url, {
      headers: {
        Authorization: `Bearer ${token}`,
        Accept:        "application/json",
      },
    }, (res) => {
      let data = "";
      res.on("data", chunk => (data += chunk));
      res.on("end", () => {
        if (res.statusCode === 404) { resolve(null); return; }
        if (res.statusCode >= 200 && res.statusCode < 300) {
          try { resolve(JSON.parse(data)); }
          catch (e) { reject(new Error(`JSON parse on ${endpoint}: ${e.message}`)); }
        } else {
          reject(new Error(`HTTP ${res.statusCode} on ${endpoint}: ${data.substring(0, 200)}`));
        }
      });
    }).on("error", reject);
  });
}

// skip/limit pagination — meta.count = total
async function fetchAll(token, endpoint, extraParams = {}) {
  const results = [];
  const limit   = 100;
  let   skip    = 0;
  while (true) {
    const res = await apiGet(token, endpoint, { ...extraParams, limit, skip });
    if (!res?.data) break;
    const items = Array.isArray(res.data) ? res.data : [res.data];
    results.push(...items);
    const total = res.meta?.count ?? items.length;
    if (results.length >= total || items.length === 0) break;
    skip += limit;
    await new Promise(r => setTimeout(r, 150));
  }
  return results;
}

// Concurrency pool
async function pooled(items, limit, fn) {
  const results = new Array(items.length);
  let i = 0;
  async function worker() {
    while (i < items.length) { const idx = i++; results[idx] = await fn(items[idx]); }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return results;
}

// ------------------------------------------------------------
// CSV HELPERS
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
function date(val) {
  if (!val || val === "always_valid") return val || "";
  return String(val).split("T")[0];
}

// ------------------------------------------------------------
// MAIN
// ------------------------------------------------------------
async function main() {
  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });

  const vendorRows       = [];
  const contactRows      = [];
  const contextRows      = [];
  const requestRows      = [];
  const subjectRows      = [];
  const requirementRows  = [];
  const errorLog         = [];

  for (const client of CLIENTS) {
    if (!client.token) {
      console.warn(`⚠️  Skipping "${client.name}" — no token`);
      continue;
    }

    console.log(`\n📋 Processing: ${client.name}`);

    // ── 1. Context Objects (project type definitions — 1 call) ──
    let contextObjectMap = {};
    try {
      const objs = await fetchAll(client.token, "/context-objects", {
        fields: "_id,name,pluralName,slug",
      });
      for (const o of objs) {
        const id = o._id || o.id;
        if (id) contextObjectMap[id] = o.name || o.pluralName || "";
      }
      console.log(`   Context object types: ${objs.length} (${objs.map(o => o.name).join(", ")})`);
    } catch (err) {
      console.warn(`   ⚠️  Context objects: ${err.message}`);
    }

    // ── 2. Context Records (all projects — 1 call) ─────────────
    // Fields: _id, contextObjectId, status, name, description,
    //         startDate, endDate, externalCodes, archivedAt, createdAt, updatedAt
    let contextRecords = [];
    try {
      contextRecords = await fetchAll(client.token, "/context-records", {
        fields: "_id,contextObjectId,status,name,description,startDate,endDate,externalCodes,archivedAt,createdAt,updatedAt",
      });
      console.log(`   Context records (projects): ${contextRecords.length}`);
    } catch (err) {
      console.error(`   ❌ Context records: ${err.message}`);
      errorLog.push({ client: client.name, stage: "context_records", error: err.message });
    }

    // Build contextId → name lookup for enriching request records
    const contextMap = {};
    for (const ctx of contextRecords) {
      const id = ctx._id || ctx.id;
      if (id) contextMap[id] = ctx.name || "";

      contextRows.push({
        client:           client.name,
        context_id:       id || "",
        context_name:     ctx.name || "",
        context_type:     contextObjectMap[ctx.contextObjectId] || ctx.contextObjectId || "",
        status:           ctx.status || "",
        description:      ctx.description || "",
        start_date:       date(ctx.startDate),
        end_date:         date(ctx.endDate),
        archived_at:      date(ctx.archivedAt),
        external_codes:   (ctx.externalCodes || []).join("; "),
        created_at:       date(ctx.createdAt),
        updated_at:       date(ctx.updatedAt),
        sync_date:        new Date().toISOString().split("T")[0],
      });
    }

    // ── 3. Primary Objects (vendor type definitions — 1 call) ───
    let primaryObjectMap = {};
    try {
      const objs = await fetchAll(client.token, "/primary-objects", {
        fields: "_id,name,pluralName,slug",
      });
      for (const o of objs) {
        const id = o._id || o.id;
        if (id) primaryObjectMap[id] = o.name || "";
      }
      console.log(`   Primary object types: ${objs.length} (${objs.map(o => o.name).join(", ")})`);
    } catch (err) {
      console.warn(`   ⚠️  Primary objects: ${err.message}`);
    }

    // ── 4. Primary Records (vendors) ────────────────────────────
    // Fields: _id, primaryObjectId, typeId, status, name, address,
    //         automationsEnabled, externalCodes, additionalNotes,
    //         createdAt, updatedAt, website, computedAttributes, contacts
    let vendors = [];
    try {
      vendors = await fetchAll(client.token, "/primary-records", {
        fields: "_id,primaryObjectId,typeId,status,name,address,externalCodes,additionalNotes,createdAt,updatedAt,website,computedAttributes,contacts",
      });
      console.log(`   Vendors: ${vendors.length}`);
    } catch (err) {
      console.error(`   ❌ Primary records: ${err.message}`);
      errorLog.push({ client: client.name, stage: "primary_records", error: err.message });
      continue;
    }

    const vendorMap = {};
    for (const v of vendors) {
      const id = v._id || v.id || "";
      vendorMap[id] = v.name || "";

      // All contacts embedded in the list response
      const contacts = v.contacts || [];
      const primaryContact = contacts.find(c => c.primary) || contacts[0] || {};

      vendorRows.push({
        client:               client.name,
        vendor_id:            id,
        vendor_name:          v.name || "",
        vendor_type:          primaryObjectMap[v.primaryObjectId] || v.primaryObjectId || "",
        status:               v.status || "",
        email:                primaryContact.email || "",
        contact_name:         primaryContact.contactPersonName || "",
        all_emails:           contacts.map(c => c.email).filter(Boolean).join("; "),
        website:              v.website || "",
        additional_notes:     v.additionalNotes || "",
        address:              v.address?.raw || [v.address?.line1, v.address?.city, v.address?.region, v.address?.postalCode].filter(Boolean).join(", ") || "",
        city:                 v.address?.city || "",
        region:               v.address?.region || "",
        country:              v.address?.country || "",
        postal_code:          v.address?.postalCode || "",
        documents_count:      v.computedAttributes?.documentsCount ?? "",
        non_responsive_since: date(v.computedAttributes?.nonResponsiveSince),
        last_request_sent:    date(v.computedAttributes?.lastRequestSentOn),
        external_codes:       (v.externalCodes || []).join("; "),
        created_at:           date(v.createdAt),
        updated_at:           date(v.updatedAt),
        sync_date:            new Date().toISOString().split("T")[0],
      });

      // contacts.csv — one row per contact per vendor
      for (const c of contacts) {
        contactRows.push({
          client:                    client.name,
          vendor_id:                 id,
          vendor_name:               v.name || "",
          email:                     c.email || "",
          contact_name:              c.contactPersonName || "",
          is_primary:                c.primary ?? false,
          is_default_request_recipient: c.defaultRequestRecipient ?? false,
          external_code:             c.externalCode || "",
          sync_date:                 new Date().toISOString().split("T")[0],
        });
      }
    }

    // ── 5. Fetch full contacts per vendor if not in list response ─
    // The list endpoint includes contacts[] already, but let's also
    // fetch /primary-records/{id}/contacts for completeness in case
    // the list truncates. We only do this for vendors with 0 contacts.
    const vendorsWithNoContacts = vendors.filter(v => !(v.contacts?.length));
    if (vendorsWithNoContacts.length > 0) {
      console.log(`   Fetching contacts for ${vendorsWithNoContacts.length} vendors with no embedded contacts...`);
      await pooled(vendorsWithNoContacts, 10, async (v) => {
        const id = v._id || v.id;
        try {
          const contacts = await fetchAll(client.token, `/primary-records/${id}/contacts`);
          for (const c of contacts) {
            contactRows.push({
              client:                       client.name,
              vendor_id:                    id,
              vendor_name:                  v.name || "",
              email:                        c.email || "",
              contact_name:                 c.contactPersonName || "",
              is_primary:                   c.primary ?? false,
              is_default_request_recipient: c.defaultRequestRecipient ?? false,
              external_code:                c.externalCode || "",
              sync_date:                    new Date().toISOString().split("T")[0],
            });
          }
        } catch (err) {
          errorLog.push({ client: client.name, stage: "contacts", vendor: id, error: err.message });
        }
      });
    }

    // ── 6. Request Records (all compliance data — 1 paginated call) ──
    // Fields: _id, primaryRecordId, contextRecordId, name, status,
    //         complianceTracking, complianceProfile, complianceStatus,
    //         createdAt, updatedAt, complianceModules
    let requestRecords = [];
    try {
      requestRecords = await fetchAll(client.token, "/request-records", {
        fields: "_id,primaryRecordId,contextRecordId,name,status,complianceTracking,complianceProfile,complianceStatus,createdAt,updatedAt,complianceModules",
      });
      console.log(`   Request records: ${requestRecords.length}`);
    } catch (err) {
      console.error(`   ❌ Request records: ${err.message}`);
      errorLog.push({ client: client.name, stage: "request_records", error: err.message });
      continue;
    }

    // ── 7. Compliance certificates per request record ────────────
    // GET /request-records/{id}/compliance-certificate
    // Returns: name, url, flag {level, subjects, notes}, status,
    //          expirationDate, issueDate, reviewedAt, appliesToAllProjects
    console.log(`   Fetching compliance certificates...`);
    const certMap = {};
    await pooled(requestRecords, 10, async (req) => {
      const reqId = req._id || req.id;
      try {
        const cert = await apiGet(client.token, `/request-records/${reqId}/compliance-certificate`);
        if (cert) certMap[reqId] = cert;
      } catch (err) {
        // 404 is normal — many request records have no cert yet
      }
    });
    console.log(`   Compliance certificates found: ${Object.keys(certMap).length}`);

    // ── 8. Build output rows ─────────────────────────────────────
    for (const req of requestRecords) {
      const reqId      = req._id || req.id || "";
      const vendorId   = req.primaryRecordId || "";
      const vendorName = vendorMap[vendorId] || req.name || "";
      const contextId  = req.contextRecordId || "";
      const contextName = contextMap[contextId] || "";
      const cert        = certMap[reqId] || {};

      requestRows.push({
        client:               client.name,
        request_id:           reqId,
        vendor_id:            vendorId,
        vendor_name:          vendorName,
        context_id:           contextId,
        context_name:         contextName,
        request_name:         req.name || "",
        status:               req.status || "",
        compliance_status:    req.complianceStatus || "",
        compliance_profile:   req.complianceProfile?.name || "",
        compliance_tracking:  req.complianceTracking ?? "",
        // Certificate fields
        cert_status:          cert.status || "",
        cert_expiration:      date(cert.expirationDate),
        cert_issue_date:      date(cert.issueDate),
        cert_reviewed_at:     date(cert.reviewedAt),
        cert_url:             cert.url || "",
        cert_flag_level:      cert.flag?.level || "",
        cert_flag_notes:      cert.flag?.notes || "",
        applies_to_all:       cert.appliesToAllProjects ?? "",
        updated_at:           date(req.updatedAt),
        sync_date:            new Date().toISOString().split("T")[0],
      });

      // Flatten complianceModules → subjects → requirements
      for (const mod of (req.complianceModules || [])) {
        for (const subj of (mod.subjects || [])) {
          subjectRows.push({
            client:                  client.name,
            request_id:              reqId,
            vendor_id:               vendorId,
            vendor_name:             vendorName,
            context_name:            contextName,
            compliance_status:       req.complianceStatus || "",
            module_code:             mod.code  || "",
            module_label:            mod.label || "",
            module_status:           mod.status || "",
            subject_code:            subj.code  || "",
            subject_label:           subj.label || "",
            subject_status:          subj.status || "",
            validity_status:         subj.validityStatus || "",
            effective_date:          date(subj.effectiveDate),
            expiration_date:         date(subj.expirationDate),
            latest_expiration_date:  date(subj.latestExpirationDate),
            latest_valid_expiration: date(subj.latestValidExpirationDate),
            cancellation_date:       date(subj.cancellation?.effectiveDate),
            documents_count:         subj.documentsCount ?? "",
            notes:                   subj.notes || "",
            sync_date:               new Date().toISOString().split("T")[0],
          });

          for (const r of (subj.requirements || [])) {
            requirementRows.push({
              client:                client.name,
              request_id:            reqId,
              vendor_id:             vendorId,
              vendor_name:           vendorName,
              context_name:          contextName,
              module_code:           r.moduleCode  || "",
              module_label:          r.moduleLabel || "",
              subject_code:          r.subjectCode  || "",
              subject_label:         r.subjectLabel || "",
              attribute_code:        r.attributeCode  || "",
              attribute_label:       r.attributeLabel || "",
              attribute_description: r.attributeDescription || "",
              operator:              r.operator || "",
              target_value:          Array.isArray(r.targetValue) ? r.targetValue.join("; ") : (r.targetValue || ""),
              actual_value:          r.value ?? "",
              status:                r.status || "",
              compliance_profile:    r.complianceProfile?.name || "",
              notes:                 r.notes || "",
              public_notes:          r.publicNotes?.content || "",
              custom:                r.custom ?? "",
              matching_criteria:     r.matchingCriteria || "",
              sync_date:             new Date().toISOString().split("T")[0],
            });
          }
        }
      }
    }

    console.log(`   ✅ ${client.name} done`);
    await new Promise(r => setTimeout(r, 300));
  }

  // Write all CSVs
  fs.writeFileSync(path.join(DATA_DIR, "vendors.csv"),           toCsv(vendorRows));
  fs.writeFileSync(path.join(DATA_DIR, "contacts.csv"),          toCsv(contactRows));
  fs.writeFileSync(path.join(DATA_DIR, "context_records.csv"),   toCsv(contextRows));
  fs.writeFileSync(path.join(DATA_DIR, "request_records.csv"),   toCsv(requestRows));
  fs.writeFileSync(path.join(DATA_DIR, "coverage_subjects.csv"), toCsv(subjectRows));
  fs.writeFileSync(path.join(DATA_DIR, "requirements.csv"),      toCsv(requirementRows));

  console.log(`\n✅ vendors.csv           — ${vendorRows.length} rows`);
  console.log(`✅ contacts.csv          — ${contactRows.length} rows`);
  console.log(`✅ context_records.csv   — ${contextRows.length} rows`);
  console.log(`✅ request_records.csv   — ${requestRows.length} rows`);
  console.log(`✅ coverage_subjects.csv — ${subjectRows.length} rows`);
  console.log(`✅ requirements.csv      — ${requirementRows.length} rows`);

  if (errorLog.length > 0) {
    const summary = {};
    errorLog.forEach(e => { summary[e.stage] = (summary[e.stage] || 0) + 1; });
    console.warn(`\n⚠️  ${errorLog.length} errors: ${JSON.stringify(summary)}`);
    fs.writeFileSync(path.join(DATA_DIR, "sync_errors.log"), JSON.stringify(errorLog, null, 2));
  }
}

main().catch(err => {
  console.error("Fatal error:", err);
  process.exit(1);
});
