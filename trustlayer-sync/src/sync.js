// ============================================================
// TrustLayer v2 → CSV Sync Script
// Full coverage of all useful GET endpoints per OpenAPI spec
//
// Endpoints used (v2 unless noted):
//   GET /context-objects                        → project type definitions
//   GET /context-records                        → all projects
//   GET /primary-objects                        → vendor type definitions
//   GET /primary-records                        → all vendors with contacts
//   GET /primary-records/{id}/contacts          → fallback contacts
//   GET /primary-records/{id}/attributes        → custom field values (v2)
//   GET /primary-records/{id}/tags              → tag assignments (v2)
//   GET /request-records                        → compliance records + modules
//   GET /request-records/{id}/compliance-certificate
//
//   [v1] GET /custom-fields                     → custom field definitions
//   [v1] GET /tags                              → tag definitions
//   [v1] GET /document-types                    → document type definitions
//   [v1] GET /documents?filter[party]={id}      → documents per vendor
//
// Output files (written to /data/):
//   vendors.csv           — vendor master
//   contacts.csv          — contacts per vendor
//   context_records.csv   — projects
//   request_records.csv   — compliance status + cert info
//   coverage_subjects.csv — per-subject coverage status + dates
//   requirements.csv      — per-attribute actual vs required
//   custom_properties.csv — custom field values (long format, matches Evident)
//   tags.csv              — tag assignments per vendor
//   documents.csv         — document metadata per vendor
// ============================================================

const https = require("https");
const fs    = require("fs");
const path  = require("path");

const CLIENTS = [
  { name: "Block Real Estate Services, LLC", token: process.env.TL_TOKEN_BLOCK_REAL_ESTATE },
  { name: "Construction Management Inc.",    token: process.env.TL_TOKEN_CMI },
  { name: "QTS Data Centers",               token: process.env.TL_TOKEN_QTS },
];

const BASE_V2  = "https://api.trustlayer.io/v2";
const BASE_V1  = "https://api.trustlayer.io/v1";
const DATA_DIR = path.join(__dirname, "..", "data");

// ------------------------------------------------------------
// HTTP HELPER
// ------------------------------------------------------------
function apiGet(token, baseUrl, endpoint, params = {}) {
  return new Promise((resolve, reject) => {
    const qs = Object.keys(params).length
      ? "?" + Object.entries(params)
          .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`)
          .join("&")
      : "";
    const url = `${baseUrl}${endpoint}${qs}`;

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

// v2 pagination: meta.count = total items
async function fetchAll(token, endpoint, extraParams = {}) {
  const results = [];
  const limit   = 100;
  let   skip    = 0;
  while (true) {
    const res = await apiGet(token, BASE_V2, endpoint, { ...extraParams, limit, skip });
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

// v1 pagination: meta.totalCount, page[number] / page[size]
async function fetchAllV1(token, endpoint, extraParams = {}) {
  const results = [];
  const size    = 100;
  let   page    = 1;
  while (true) {
    const res = await apiGet(token, BASE_V1, endpoint, {
      ...extraParams,
      "page[number]": page,
      "page[size]":   size,
    });
    if (!res?.data) break;
    const items = Array.isArray(res.data) ? res.data : [res.data];
    results.push(...items);
    const total = res.meta?.totalCount ?? items.length;
    if (results.length >= total || items.length === 0) break;
    page++;
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

  const vendorRows          = [];
  const contactRows         = [];
  const contextRows         = [];
  const requestRows         = [];
  const subjectRows         = [];
  const requirementRows     = [];
  const customPropertyRows  = [];
  const tagRows             = [];
  const documentRows        = [];
  const errorLog            = [];

  for (const client of CLIENTS) {
    if (!client.token) {
      console.warn(`⚠️  Skipping "${client.name}" — no token`);
      continue;
    }

    console.log(`\n📋 Processing: ${client.name}`);

    // ── A. Custom field definitions (v1) ──────────────────────
    let customFieldMap = {}; // id → { name, type }
    try {
      const fields = await fetchAllV1(client.token, "/custom-fields");
      for (const f of fields) {
        const id = f.id || f._id;
        if (id) customFieldMap[id] = { name: f.name || f.label || id, type: f.type || "" };
      }
      console.log(`   Custom field definitions: ${fields.length}`);
    } catch (err) {
      console.warn(`   ⚠️  Custom fields: ${err.message}`);
    }

    // ── B. Tag definitions (v1) ────────────────────────────────
    let tagMap = {}; // id → name
    try {
      const tags = await fetchAllV1(client.token, "/tags");
      for (const t of tags) {
        const id = t.id || t._id;
        if (id) tagMap[id] = t.name || id;
      }
      console.log(`   Tag definitions: ${tags.length}`);
    } catch (err) {
      console.warn(`   ⚠️  Tags: ${err.message}`);
    }

    // ── C. Document type definitions (v1) ─────────────────────
    let docTypeMap = {}; // id → name
    try {
      const docTypes = await fetchAllV1(client.token, "/document-types");
      for (const dt of docTypes) {
        const id = dt.id || dt._id;
        if (id) docTypeMap[id] = dt.name || dt.label || id;
      }
      console.log(`   Document type definitions: ${docTypes.length}`);
    } catch (err) {
      console.warn(`   ⚠️  Document types: ${err.message}`);
    }

    // ── 1. Context Objects ─────────────────────────────────────
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

    // ── 2. Context Records ─────────────────────────────────────
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

    const contextMap = {};
    for (const ctx of contextRecords) {
      const id = ctx._id || ctx.id;
      if (id) contextMap[id] = ctx.name || "";
      contextRows.push({
        client:         client.name,
        context_id:     id || "",
        context_name:   ctx.name || "",
        context_type:   contextObjectMap[ctx.contextObjectId] || ctx.contextObjectId || "",
        status:         ctx.status || "",
        description:    ctx.description || "",
        start_date:     date(ctx.startDate),
        end_date:       date(ctx.endDate),
        archived_at:    date(ctx.archivedAt),
        external_codes: (ctx.externalCodes || []).join("; "),
        created_at:     date(ctx.createdAt),
        updated_at:     date(ctx.updatedAt),
        sync_date:      new Date().toISOString().split("T")[0],
      });
    }

    // ── 3. Primary Objects ─────────────────────────────────────
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

    // ── 4. Primary Records (vendors) ──────────────────────────
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
      const id       = v._id || v.id || "";
      vendorMap[id]  = v.name || "";
      const contacts = v.contacts || [];
      const primary  = contacts.find(c => c.primary) || contacts[0] || {};

      vendorRows.push({
        client:               client.name,
        vendor_id:            id,
        vendor_name:          v.name || "",
        vendor_type:          primaryObjectMap[v.primaryObjectId] || v.primaryObjectId || "",
        status:               v.status || "",
        email:                primary.email || "",
        contact_name:         primary.contactPersonName || "",
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
    }

    // ── 5. Fallback contacts for vendors with no embedded contacts
    const vendorsWithNoContacts = vendors.filter(v => !(v.contacts?.length));
    if (vendorsWithNoContacts.length > 0) {
      console.log(`   Fetching contacts for ${vendorsWithNoContacts.length} vendors...`);
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

    // ── 6. Attributes (custom properties) per vendor ──────────
    console.log(`   Fetching attributes (custom properties) for ${vendors.length} vendors...`);
    await pooled(vendors, 8, async (v) => {
      const vid = v._id || v.id;
      try {
        const attrs = await fetchAll(client.token, `/primary-records/${vid}/attributes`);
        for (const a of attrs) {
          const fieldId   = a.id || "";
          const fieldDef  = customFieldMap[fieldId] || {};
          const fieldName = fieldDef.name || fieldId;
          const rawValue  = a.value !== undefined ? a.value
            : (a.optionIds ? a.optionIds.join("; ") : "");
          customPropertyRows.push({
            client:        client.name,
            insured_name:  v.name || "",
            contact_email: (v.contacts?.find(c => c.primary) || v.contacts?.[0] || {}).email || "",
            field_name:    fieldName,
            field_value:   String(rawValue),
            field_id:      fieldId,
            sync_date:     new Date().toISOString().split("T")[0],
          });
        }
      } catch (err) {
        errorLog.push({ client: client.name, stage: "attributes", vendor: vid, error: err.message });
      }
    });

    // ── 7. Tags per vendor ────────────────────────────────────
    console.log(`   Fetching tags for ${vendors.length} vendors...`);
    await pooled(vendors, 8, async (v) => {
      const vid = v._id || v.id;
      try {
        const tags = await fetchAll(client.token, `/primary-records/${vid}/tags`);
        for (const t of tags) {
          const tagId   = t.id || "";
          const tagName = tagMap[tagId] || tagId;
          tagRows.push({
            client:      client.name,
            vendor_id:   vid,
            vendor_name: v.name || "",
            tag_id:      tagId,
            tag_name:    tagName,
            expires_at:  date(t.expiresAt),
            sync_date:   new Date().toISOString().split("T")[0],
          });
        }
      } catch (err) {
        errorLog.push({ client: client.name, stage: "tags", vendor: vid, error: err.message });
      }
    });

    // ── 8. Documents per vendor (v1 API) ─────────────────────
    // v1 /documents uses the same underlying MongoDB IDs as v2 primary-records
    console.log(`   Fetching documents for ${vendors.length} vendors...`);
    await pooled(vendors, 5, async (v) => {
      const vid = v._id || v.id;
      try {
        const docs = await fetchAllV1(client.token, "/documents", {
          "filter[party]": vid,
          "filter[archived]": false,
        });
        for (const d of docs) {
          const docId   = d.id || d._id || "";
          const types   = (d.types || []).map(t => docTypeMap[t.id] || t.id).join("; ");
          const flagged = !!(d.flag?.addedOn);
          documentRows.push({
            client:           client.name,
            vendor_id:        vid,
            vendor_name:      v.name || "",
            document_id:      docId,
            document_name:    d.name || "",
            document_types:   types,
            status:           d.status || "",
            reviewed_at:      date(d.reviewedAt),
            archived_at:      date(d.archivedAt),
            expiration_date:  date(d.expirationDate),
            issue_date:       date(d.issueDate),
            flagged:          flagged,
            flag_level:       d.flag?.severityLevel || "",
            flag_notes:       d.flag?.notes || "",
            applies_to_all:   d.appliesToAllProjects ?? "",
            insurer_names:    (d.insurers || []).map(i => i.canonicalName || i.extractedName || "").filter(Boolean).join("; "),
            created_at:       date(d.createdAt),
            sync_date:        new Date().toISOString().split("T")[0],
          });
        }
      } catch (err) {
        errorLog.push({ client: client.name, stage: "documents", vendor: vid, error: err.message });
      }
    });

    // ── 9. Request Records ────────────────────────────────────
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

    // ── 10. Compliance certificates ───────────────────────────
    console.log(`   Fetching compliance certificates...`);
    const certMap = {};
    await pooled(requestRecords, 10, async (req) => {
      const reqId = req._id || req.id;
      try {
        const cert = await apiGet(client.token, BASE_V2, `/request-records/${reqId}/compliance-certificate`);
        if (cert) certMap[reqId] = cert;
      } catch (err) {
        // 404 is normal — many request records have no cert
      }
    });
    console.log(`   Compliance certificates found: ${Object.keys(certMap).length}`);

    // ── 11. Build request/subject/requirement rows ─────────────
    for (const req of requestRecords) {
      const reqId       = req._id || req.id || "";
      const vendorId    = req.primaryRecordId || "";
      const vendorName  = vendorMap[vendorId] || req.name || "";
      const contextId   = req.contextRecordId || "";
      const contextName = contextMap[contextId] || "";
      const cert        = certMap[reqId] || {};

      requestRows.push({
        client:              client.name,
        request_id:          reqId,
        vendor_id:           vendorId,
        vendor_name:         vendorName,
        context_id:          contextId,
        context_name:        contextName,
        request_name:        req.name || "",
        status:              req.status || "",
        compliance_status:   req.complianceStatus || "",
        compliance_profile:  req.complianceProfile?.name || "",
        compliance_tracking: req.complianceTracking ?? "",
        cert_status:         cert.status || "",
        cert_expiration:     date(cert.expirationDate),
        cert_issue_date:     date(cert.issueDate),
        cert_reviewed_at:    date(cert.reviewedAt),
        cert_url:            cert.url || "",
        cert_flag_level:     cert.flag?.level || "",
        cert_flag_notes:     cert.flag?.notes || "",
        applies_to_all:      cert.appliesToAllProjects ?? "",
        updated_at:          date(req.updatedAt),
        sync_date:           new Date().toISOString().split("T")[0],
      });

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
  fs.writeFileSync(path.join(DATA_DIR, "custom_properties.csv"), toCsv(customPropertyRows));
  fs.writeFileSync(path.join(DATA_DIR, "tags.csv"),              toCsv(tagRows));
  fs.writeFileSync(path.join(DATA_DIR, "documents.csv"),         toCsv(documentRows));

  console.log(`\n✅ vendors.csv           — ${vendorRows.length} rows`);
  console.log(`✅ contacts.csv          — ${contactRows.length} rows`);
  console.log(`✅ context_records.csv   — ${contextRows.length} rows`);
  console.log(`✅ request_records.csv   — ${requestRows.length} rows`);
  console.log(`✅ coverage_subjects.csv — ${subjectRows.length} rows`);
  console.log(`✅ requirements.csv      — ${requirementRows.length} rows`);
  console.log(`✅ custom_properties.csv — ${customPropertyRows.length} rows`);
  console.log(`✅ tags.csv              — ${tagRows.length} rows`);
  console.log(`✅ documents.csv         — ${documentRows.length} rows`);

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
