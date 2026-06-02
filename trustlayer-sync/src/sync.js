// ============================================================
// TrustLayer v2 → CSV Sync Script
// COMPLETE coverage of every GET endpoint in the v2 OpenAPI spec
//
// v2 endpoints:
//   GET /workspace
//   GET /views
//   GET /context-objects
//   GET /context-objects/{id}                        (skipped — covered by list)
//   GET /context-records
//   GET /context-records/{id}/attributes
//   GET /context-records/{id}/request-records        (via top-level /request-records)
//   GET /primary-objects
//   GET /primary-objects/{id}                        (skipped — covered by list)
//   GET /primary-records
//   GET /primary-records/{id}/contacts
//   GET /primary-records/{id}/attributes
//   GET /primary-records/{id}/tags
//   GET /primary-records/{id}/request-records        (via top-level /request-records)
//   GET /primary-records/{id}/request-records/{recordId}/compliance-certificate
//   GET /request-records
//   GET /request-records/{id}/attributes
//   GET /request-records/{id}/compliance-certificate
//   GET /documents/{id}/amendments
//   GET /policies/{number}
//   GET /policies/{number}/documents
//   GET /policies/{number}/amendments
//
// v1 endpoints (no v2 equivalents):
//   GET /custom-fields
//   GET /tags
//   GET /document-types
//   GET /documents?filter[party]={id}
//
// Output CSVs written to /data/:
//   workspace.csv
//   views.csv
//   vendors.csv
//   contacts.csv
//   vendor_attributes.csv
//   vendor_tags.csv
//   context_objects.csv
//   context_records.csv
//   context_record_attributes.csv
//   primary_objects.csv
//   request_records.csv
//   request_record_attributes.csv
//   coverage_subjects.csv
//   requirements.csv
//   documents.csv
//   document_amendments.csv
//   policies.csv
//   policy_documents.csv
//   policy_amendments.csv
//   custom_field_definitions.csv
//   tag_definitions.csv
//   document_type_definitions.csv
// ============================================================

const https = require("https");
const fs    = require("fs");
const path  = require("path");

const CLIENTS = [
  { name: "Block Real Estate Services, LLC", token: process.env.TL_TOKEN_BLOCK_REAL_ESTATE },
  { name: "Construction Management Inc.",    token: process.env.TL_TOKEN_CMI },
  { name: "QTS Data Centers",               token: process.env.TL_TOKEN_QTS },
  { name: "Excel Constructors",             token: process.env.TL_TOKEN_EXCEL_CONSTRUCTORS },
  { name: "DEMO Client",                    token: process.env.TL_TOKEN_DEMOCLIENT },
];

const BASE_V2  = "https://api.trustlayer.io/v2";
const BASE_V1  = "https://api.trustlayer.io/v1";
const DATA_DIR = path.join(__dirname, "..", "data");
const TODAY    = new Date().toISOString().split("T")[0];

// ------------------------------------------------------------
// HTTP HELPERS
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
      headers: { Authorization: `Bearer ${token}`, Accept: "application/json" },
    }, (res) => {
      let data = "";
      res.on("data", chunk => (data += chunk));
      res.on("end", () => {
        if (res.statusCode === 404) { resolve(null); return; }
        if (res.statusCode >= 200 && res.statusCode < 300) {
          try { resolve(JSON.parse(data)); }
          catch (e) { reject(new Error(`JSON parse on ${endpoint}: ${e.message}`)); }
        } else {
          reject(new Error(`HTTP ${res.statusCode} on ${endpoint}: ${data.substring(0, 300)}`));
        }
      });
    }).on("error", reject);
  });
}

async function fetchAll(token, endpoint, extraParams = {}) {
  const results = [];
  const limit   = 100;
  let   skip    = 0;
  while (true) {
    const res = await apiGet(token, BASE_V2, endpoint, { ...extraParams, limit, skip });
    if (!res?.data) break;
    const items = Array.isArray(res.data) ? res.data : [res.data];
    results.push(...items);
    if (results.length >= (res.meta?.count ?? items.length) || items.length === 0) break;
    skip += limit;
    await sleep(150);
  }
  return results;
}

async function fetchAllV1(token, endpoint, extraParams = {}) {
  const results = [];
  let   page    = 1;
  while (true) {
    const res = await apiGet(token, BASE_V1, endpoint, {
      ...extraParams, "page[number]": page, "page[size]": 100,
    });
    if (!res?.data) break;
    const items = Array.isArray(res.data) ? res.data : [res.data];
    results.push(...items);
    if (results.length >= (res.meta?.totalCount ?? items.length) || items.length === 0) break;
    page++;
    await sleep(150);
  }
  return results;
}

async function pooled(items, concurrency, fn) {
  const results = new Array(items.length);
  let i = 0;
  async function worker() {
    while (i < items.length) { const idx = i++; results[idx] = await fn(items[idx]); }
  }
  await Promise.all(Array.from({ length: Math.min(concurrency, items.length) }, worker));
  return results;
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

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
function dt(val) {
  if (!val || val === "always_valid") return val || "";
  return String(val).split("T")[0];
}
function write(name, rows) {
  fs.writeFileSync(path.join(DATA_DIR, name), toCsv(rows));
  console.log(`  ✅ ${name.padEnd(45)} — ${rows.length} rows`);
}

// ------------------------------------------------------------
// MAIN
// ------------------------------------------------------------
async function main() {
  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });

  // All row accumulators — one per output CSV
  const rows = {
    workspace:               [],
    views:                   [],
    context_objects:         [],
    context_records:         [],
    context_record_attrs:    [],
    primary_objects:         [],
    vendors:                 [],
    contacts:                [],
    vendor_attrs:            [],
    vendor_tags:             [],
    request_records:         [],
    request_record_attrs:    [],
    coverage_subjects:       [],
    requirements:            [],
    documents:               [],
    document_amendments:     [],
    policies:                [],
    policy_documents:        [],
    policy_amendments:       [],
    custom_field_defs:       [],
    tag_defs:                [],
    doc_type_defs:           [],
    errors:                  [],
  };

  for (const client of CLIENTS) {
    if (!client.token) {
      console.warn(`\n⚠️  Skipping "${client.name}" — no token`);
      continue;
    }
    console.log(`\n${"=".repeat(60)}`);
    console.log(`  ${client.name}`);
    console.log(`${"=".repeat(60)}`);

    const err = (stage, extra, e) => {
      console.warn(`  ⚠️  ${stage}: ${e.message}`);
      rows.errors.push({ client: client.name, stage, ...extra, error: e.message, sync_date: TODAY });
    };

    // ── WORKSPACE ─────────────────────────────────────────────
    try {
      const ws = await apiGet(client.token, BASE_V2, "/workspace");
      if (ws) {
        rows.workspace.push({
          client:      client.name,
          id:          ws._id || "",
          name:        ws.name || "",
          slug:        ws.slugifyName || "",
          description: ws.description || "",
          api_version: ws.apiVersion ?? "",
          sync_date:   TODAY,
        });
        console.log(`  Workspace: ${ws.name} (API v${ws.apiVersion})`);
      }
    } catch(e) { err("workspace", {}, e); }

    // ── VIEWS ─────────────────────────────────────────────────
    try {
      const views = await fetchAll(client.token, "/views");
      for (const v of views) {
        rows.views.push({
          client:      client.name,
          id:          v._id || "",
          name:        v.name || "",
          type:        v.type || "",
          visibility:  v.visibility || "",
          readonly:    v.readonly ?? "",
          ref_type:    v.reference?.type || "",
          ref_id:      v.reference?.id || "",
          user_id:     v.userId || "",
          filter_json: v.filter ? JSON.stringify(v.filter) : "",
          created_at:  dt(v.createdAt),
          updated_at:  dt(v.updatedAt),
          sync_date:   TODAY,
        });
      }
      console.log(`  Views: ${views.length}`);
    } catch(e) { err("views", {}, e); }

    // ── v1 REFERENCE DATA ─────────────────────────────────────
    // Custom field definitions
    let customFieldMap = {};
    try {
      const fields = await fetchAllV1(client.token, "/custom-fields");
      for (const f of fields) {
        const id = f.id || f._id;
        if (id) customFieldMap[id] = { name: f.name || f.label || id, type: f.type || "" };
        rows.custom_field_defs.push({
          client:    client.name,
          id:        id || "",
          name:      f.name || f.label || "",
          type:      f.type || "",
          sync_date: TODAY,
        });
      }
      console.log(`  Custom field defs: ${fields.length}`);
    } catch(e) { err("custom_field_defs", {}, e); }

    // Tag definitions
    let tagMap = {};
    try {
      const tags = await fetchAllV1(client.token, "/tags");
      for (const t of tags) {
        const id = t.id || t._id;
        if (id) tagMap[id] = t.name || id;
        rows.tag_defs.push({
          client:    client.name,
          id:        id || "",
          name:      t.name || "",
          sync_date: TODAY,
        });
      }
      console.log(`  Tag defs: ${tags.length}`);
    } catch(e) { err("tag_defs", {}, e); }

    // Document type definitions
    let docTypeMap = {};
    try {
      const types = await fetchAllV1(client.token, "/document-types");
      for (const dt of types) {
        const id = dt.id || dt._id;
        if (id) docTypeMap[id] = dt.name || dt.label || id;
        rows.doc_type_defs.push({
          client:    client.name,
          id:        id || "",
          name:      dt.name || dt.label || "",
          sync_date: TODAY,
        });
      }
      console.log(`  Document type defs: ${types.length}`);
    } catch(e) { err("doc_type_defs", {}, e); }

    // ── CONTEXT OBJECTS ────────────────────────────────────────
    let contextObjectMap = {};
    try {
      const objs = await fetchAll(client.token, "/context-objects");
      for (const o of objs) {
        const id = o._id || o.id;
        if (id) contextObjectMap[id] = o.name || "";
        rows.context_objects.push({
          client:      client.name,
          id:          id || "",
          name:        o.name || "",
          plural_name: o.pluralName || "",
          slug:        o.slug || "",
          icon:        o.icon || "",
          created_at:  dt(o.createdAt),
          updated_at:  dt(o.updatedAt),
          sync_date:   TODAY,
        });
      }
      console.log(`  Context objects: ${objs.length}`);
    } catch(e) { err("context_objects", {}, e); }

    // ── CONTEXT RECORDS ────────────────────────────────────────
    let contextRecords = [];
    let contextMap = {};
    try {
      contextRecords = await fetchAll(client.token, "/context-records");
      for (const c of contextRecords) {
        const id = c._id || c.id;
        if (id) contextMap[id] = c.name || "";
        rows.context_records.push({
          client:         client.name,
          id:             id || "",
          name:           c.name || "",
          context_object: contextObjectMap[c.contextObjectId] || c.contextObjectId || "",
          status:         c.status || "",
          description:    c.description || "",
          start_date:     dt(c.startDate),
          end_date:       dt(c.endDate),
          archived_at:    dt(c.archivedAt),
          external_codes: (c.externalCodes || []).join("; "),
          created_at:     dt(c.createdAt),
          updated_at:     dt(c.updatedAt),
          sync_date:      TODAY,
        });
      }
      console.log(`  Context records: ${contextRecords.length}`);
    } catch(e) { err("context_records", {}, e); }

    // ── CONTEXT RECORD ATTRIBUTES ──────────────────────────────
    console.log(`  Fetching context record attributes (${contextRecords.length} records)...`);
    await pooled(contextRecords, 8, async (c) => {
      const cid = c._id || c.id;
      try {
        const attrs = await fetchAll(client.token, `/context-records/${cid}/attributes`);
        for (const a of attrs) {
          const fid  = a.id || "";
          const fdef = customFieldMap[fid] || {};
          rows.context_record_attrs.push({
            client:       client.name,
            context_id:   cid,
            context_name: c.name || "",
            field_id:     fid,
            field_name:   fdef.name || fid,
            field_type:   fdef.type || "",
            value:        a.value !== undefined ? String(a.value)
                          : (a.optionIds ? a.optionIds.join("; ") : ""),
            sync_date:    TODAY,
          });
        }
      } catch(e) { err("context_record_attrs", { context_id: cid }, e); }
    });

    // ── PRIMARY OBJECTS ────────────────────────────────────────
    let primaryObjectMap = {};
    try {
      const objs = await fetchAll(client.token, "/primary-objects");
      for (const o of objs) {
        const id = o._id || o.id;
        if (id) primaryObjectMap[id] = o.name || "";
        rows.primary_objects.push({
          client:      client.name,
          id:          id || "",
          name:        o.name || "",
          plural_name: o.pluralName || "",
          slug:        o.slug || "",
          icon:        o.icon || "",
          created_at:  dt(o.createdAt),
          updated_at:  dt(o.updatedAt),
          sync_date:   TODAY,
        });
      }
      console.log(`  Primary objects: ${objs.length}`);
    } catch(e) { err("primary_objects", {}, e); }

    // ── PRIMARY RECORDS (vendors) ──────────────────────────────
    let vendors = [];
    let vendorMap = {};
    try {
      vendors = await fetchAll(client.token, "/primary-records");
      for (const v of vendors) {
        const id       = v._id || v.id || "";
        vendorMap[id]  = v.name || "";
        const contacts = v.contacts || [];
        const primary  = contacts.find(c => c.primary) || contacts[0] || {};
        rows.vendors.push({
          client:               client.name,
          id:                   id,
          name:                 v.name || "",
          type:                 primaryObjectMap[v.primaryObjectId] || v.primaryObjectId || "",
          type_id:              v.typeId || "",
          status:               v.status || "",
          primary_email:        primary.email || "",
          primary_contact_name: primary.contactPersonName || "",
          all_emails:           contacts.map(c => c.email).filter(Boolean).join("; "),
          website:              v.website || "",
          additional_notes:     v.additionalNotes || "",
          address_raw:          v.address?.raw || "",
          address_line1:        v.address?.line1 || "",
          address_city:         v.address?.city || "",
          address_region:       v.address?.region || "",
          address_country:      v.address?.country || "",
          address_postal:       v.address?.postalCode || "",
          documents_count:      v.computedAttributes?.documentsCount ?? "",
          non_responsive_since: dt(v.computedAttributes?.nonResponsiveSince),
          last_message_sent:    dt(v.computedAttributes?.lastMessageSentOn),
          external_codes:       (v.externalCodes || []).join("; "),
          automations_enabled:  (v.automationsEnabled || []).join("; "),
          created_at:           dt(v.createdAt),
          updated_at:           dt(v.updatedAt),
          sync_date:            TODAY,
        });
        for (const c of contacts) {
          rows.contacts.push({
            client:                      client.name,
            vendor_id:                   id,
            vendor_name:                 v.name || "",
            email:                       c.email || "",
            contact_name:                c.contactPersonName || "",
            is_primary:                  c.primary ?? false,
            is_default_request_recipient:c.defaultRequestRecipient ?? false,
            external_code:               c.externalCode || "",
            sync_date:                   TODAY,
          });
        }
      }
      console.log(`  Vendors: ${vendors.length}`);
    } catch(e) {
      err("primary_records", {}, e);
      continue; // can't proceed without vendors
    }

    // ── FALLBACK CONTACTS (vendors with no embedded contacts) ──
    const noContacts = vendors.filter(v => !(v.contacts?.length));
    if (noContacts.length) {
      console.log(`  Fetching contacts for ${noContacts.length} vendors (no embedded contacts)...`);
      await pooled(noContacts, 10, async (v) => {
        const id = v._id || v.id;
        try {
          const contacts = await fetchAll(client.token, `/primary-records/${id}/contacts`);
          for (const c of contacts) {
            rows.contacts.push({
              client:                      client.name,
              vendor_id:                   id,
              vendor_name:                 v.name || "",
              email:                       c.email || "",
              contact_name:                c.contactPersonName || "",
              is_primary:                  c.primary ?? false,
              is_default_request_recipient:c.defaultRequestRecipient ?? false,
              external_code:               c.externalCode || "",
              sync_date:                   TODAY,
            });
          }
        } catch(e) { err("contacts_fallback", { vendor_id: id }, e); }
      });
    }

    // ── VENDOR ATTRIBUTES ──────────────────────────────────────
    console.log(`  Fetching vendor attributes (${vendors.length} vendors)...`);
    await pooled(vendors, 8, async (v) => {
      const id = v._id || v.id;
      try {
        const attrs = await fetchAll(client.token, `/primary-records/${id}/attributes`);
        for (const a of attrs) {
          const fid  = a.id || "";
          const fdef = customFieldMap[fid] || {};
          rows.vendor_attrs.push({
            client:      client.name,
            vendor_id:   id,
            vendor_name: v.name || "",
            field_id:    fid,
            field_name:  fdef.name || fid,
            field_type:  fdef.type || "",
            value:       a.value !== undefined ? String(a.value)
                         : (a.optionIds ? a.optionIds.join("; ") : ""),
            option_id:   a.optionId || "",
            sync_date:   TODAY,
          });
        }
      } catch(e) { err("vendor_attrs", { vendor_id: id }, e); }
    });

    // ── VENDOR TAGS ────────────────────────────────────────────
    console.log(`  Fetching vendor tags (${vendors.length} vendors)...`);
    await pooled(vendors, 8, async (v) => {
      const id = v._id || v.id;
      try {
        const tags = await fetchAll(client.token, `/primary-records/${id}/tags`);
        for (const t of tags) {
          const tid = t.id || "";
          rows.vendor_tags.push({
            client:      client.name,
            vendor_id:   id,
            vendor_name: v.name || "",
            tag_id:      tid,
            tag_name:    tagMap[tid] || tid,
            expires_at:  dt(t.expiresAt),
            sync_date:   TODAY,
          });
        }
      } catch(e) { err("vendor_tags", { vendor_id: id }, e); }
    });

    // ── DOCUMENTS (v1) ─────────────────────────────────────────
    console.log(`  Fetching documents (${vendors.length} vendors)...`);
    const allDocIds = [];
    await pooled(vendors, 5, async (v) => {
      const id = v._id || v.id;
      try {
        const docs = await fetchAllV1(client.token, "/documents", {
          "filter[party]":    id,
          "filter[archived]": false,
        });
        for (const d of docs) {
          const did   = d.id || d._id || "";
          const types = (d.types || []).map(t => docTypeMap[t.id] || t.id).join("; ");
          allDocIds.push({ did, client_name: client.name });
          rows.documents.push({
            client:          client.name,
            id:              did,
            vendor_id:       id,
            vendor_name:     v.name || "",
            name:            d.name || "",
            types:           types,
            policy_number:   d.policyNumber || d.policy_number || (d.data?.policyNumber) || "",
            status:          d.status || "",
            processing:      d.processing ?? "",
            reviewed_at:     dt(d.reviewedAt),
            archived_at:     dt(d.archivedAt),
            expiration_date: dt(d.expirationDate),
            issue_date:      dt(d.issueDate),
            flagged:         !!(d.flag?.addedOn),
            flag_level:      d.flag?.severityLevel || d.flag?.level || "",
            flag_notes:      d.flag?.notes || "",
            applies_to_all:  d.appliesToAllProjects ?? "",
            insurer_names:   (d.insurers || []).map(i => i.canonicalName || i.extractedName || "").filter(Boolean).join("; "),
            created_at:      dt(d.createdAt),
            updated_at:      dt(d.updatedAt),
            sync_date:       TODAY,
          });
        }
      } catch(e) { err("documents", { vendor_id: id }, e); }
    });

    // ── DOCUMENT AMENDMENTS (GET /documents/{id}/amendments) ───
    console.log(`  Fetching document amendments (${allDocIds.length} documents)...`);
    await pooled(allDocIds, 8, async ({ did, client_name }) => {
      try {
        const amendments = await fetchAll(client.token, `/documents/${did}/amendments`);
        for (const a of amendments) {
          rows.document_amendments.push({
            client:            client_name,
            amendment_id:      a._id || "",
            document_id:       did,
            vendor_id:         a.primaryRecordId || "",
            vendor_name:       vendorMap[a.primaryRecordId] || "",
            policy_number:     a.policyNumber || "",
            type:              a.type || "",
            status:            a.status || "",
            subjects:          (a.matchingSubjects || a.subjects || []).map(s => s.label || s.code || "").join("; "),
            effective_date:    dt(a.effectiveDate),
            issue_date:        dt(a.issueDate),
            notes:             a.notes || "",
            linked_doc_id:     a.document?.id || "",
            sync_date:         TODAY,
          });
        }
      } catch(e) { err("document_amendments", { document_id: did }, e); }
    });

    // ── REQUEST RECORDS ────────────────────────────────────────
    let requestRecords = [];
    try {
      requestRecords = await fetchAll(client.token, "/request-records", {
        fields: "_id,primaryRecordId,contextRecordId,name,status,complianceTracking,complianceProfile,complianceStatus,createdAt,updatedAt,complianceModules",
      });
      console.log(`  Request records: ${requestRecords.length}`);
    } catch(e) {
      err("request_records", {}, e);
      continue;
    }

    // ── REQUEST RECORD ATTRIBUTES ──────────────────────────────
    console.log(`  Fetching request record attributes (${requestRecords.length} records)...`);
    await pooled(requestRecords, 8, async (req) => {
      const rid = req._id || req.id;
      try {
        const attrs = await fetchAll(client.token, `/request-records/${rid}/attributes`);
        for (const a of attrs) {
          const fid  = a.id || "";
          const fdef = customFieldMap[fid] || {};
          rows.request_record_attrs.push({
            client:       client.name,
            request_id:   rid,
            request_name: req.name || "",
            vendor_id:    req.primaryRecordId || "",
            vendor_name:  vendorMap[req.primaryRecordId] || "",
            context_id:   req.contextRecordId || "",
            context_name: contextMap[req.contextRecordId] || "",
            field_id:     fid,
            field_name:   fdef.name || fid,
            field_type:   fdef.type || "",
            value:        a.value !== undefined ? String(a.value)
                          : (a.optionIds ? a.optionIds.join("; ") : ""),
            option_id:    a.optionId || "",
            sync_date:    TODAY,
          });
        }
      } catch(e) { err("request_record_attrs", { request_id: rid }, e); }
    });

    // ── COMPLIANCE CERTIFICATES ────────────────────────────────
    console.log(`  Fetching compliance certs (${requestRecords.length} request records)...`);
    const certMap = {};
    await pooled(requestRecords, 10, async (req) => {
      const rid = req._id || req.id;
      try {
        const cert = await apiGet(client.token, BASE_V2, `/request-records/${rid}/compliance-certificate`);
        if (cert) certMap[rid] = cert;
      } catch(e) { /* 404 is normal */ }
    });
    console.log(`  Compliance certs found: ${Object.keys(certMap).length}`);

    // ── BUILD REQUEST / SUBJECT / REQUIREMENT ROWS ─────────────
    for (const req of requestRecords) {
      const rid     = req._id || req.id || "";
      const vid     = req.primaryRecordId || "";
      const cid     = req.contextRecordId || "";
      const cert    = certMap[rid] || {};

      rows.request_records.push({
        client:              client.name,
        id:                  rid,
        vendor_id:           vid,
        vendor_name:         vendorMap[vid] || "",
        context_id:          cid,
        context_name:        contextMap[cid] || "",
        name:                req.name || "",
        status:              req.status || "",
        compliance_status:   req.complianceStatus || "",
        compliance_profile:  req.complianceProfile?.name || "",
        compliance_tracking: req.complianceTracking ?? "",
        cert_status:         cert.status || "",
        cert_expiration:     dt(cert.expirationDate),
        cert_issue_date:     dt(cert.issueDate),
        cert_reviewed_at:    dt(cert.reviewedAt),
        cert_url:            cert.url || "",
        cert_processing:     cert.processing ?? "",
        cert_flagged:        !!(cert.flag?.addedOn),
        cert_flag_level:     cert.flag?.level || "",
        cert_flag_notes:     cert.flag?.notes || "",
        cert_applies_to_all: cert.appliesToAllProjects ?? "",
        updated_at:          dt(req.updatedAt),
        sync_date:           TODAY,
      });

      for (const mod of (req.complianceModules || [])) {
        for (const subj of (mod.subjects || [])) {
          rows.coverage_subjects.push({
            client:                 client.name,
            request_id:             rid,
            vendor_id:              vid,
            vendor_name:            vendorMap[vid] || "",
            context_id:             cid,
            context_name:           contextMap[cid] || "",
            compliance_status:      req.complianceStatus || "",
            module_code:            mod.code  || "",
            module_label:           mod.label || "",
            module_status:          mod.status || "",
            subject_code:           subj.code  || "",
            subject_label:          subj.label || "",
            subject_status:         subj.status || "",
            validity_status:        subj.validityStatus || "",
            effective_date:         dt(subj.effectiveDate),
            expiration_date:        dt(subj.expirationDate),
            latest_expiration:      dt(subj.latestExpirationDate),
            latest_valid_expiration:dt(subj.latestValidExpirationDate),
            latest_valid_effective: dt(subj.latestValidEffectiveDate),
            cancellation_date:      dt(subj.cancellation?.effectiveDate),
            cancellation_issue_date:dt(subj.cancellation?.issueDate),
            notes:                  subj.notes || "",
            documents_count:        subj.documentsCount ?? "",
            reset_on:               dt(subj.resetOn),
            sync_date:              TODAY,
          });

          for (const r of (subj.requirements || [])) {
            rows.requirements.push({
              client:               client.name,
              request_id:           rid,
              vendor_id:            vid,
              vendor_name:          vendorMap[vid] || "",
              context_id:           cid,
              context_name:         contextMap[cid] || "",
              module_code:          r.moduleCode   || "",
              module_label:         r.moduleLabel  || "",
              subject_code:         r.subjectCode  || "",
              subject_label:        r.subjectLabel || "",
              attribute_code:       r.attributeCode   || "",
              attribute_label:      r.attributeLabel  || "",
              attribute_description:r.attributeDescription || "",
              matching_criteria:    r.matchingCriteria || "",
              operator:             r.operator || "",
              target_value:         Array.isArray(r.targetValue)
                                    ? r.targetValue.join("; ")
                                    : (r.targetValue || ""),
              actual_value:         r.value ?? "",
              status:               r.status || "",
              compliance_profile:   r.complianceProfile?.name || "",
              notes:                r.notes || "",
              public_notes:         r.publicNotes?.content || "",
              is_custom:            r.custom ?? "",
              documents_count:      r.documentsCount ?? "",
              reset_on:             dt(r.resetOn),
              sync_date:            TODAY,
            });
          }
        }
      }
    }

    // ── POLICIES ───────────────────────────────────────────────
    // Collect policy numbers from every possible source in documents
    const policyNumSet = new Set();
    for (const d of rows.documents.filter(d => d.client === client.name)) {
      if (d.policy_number) policyNumSet.add(String(d.policy_number).trim());
    }
    // Also check coverage subjects for any policy numbers embedded in subject labels
    // (belt and suspenders — the main source is documents above)

    console.log(`  Unique policy numbers: ${policyNumSet.size}`);
    if (policyNumSet.size > 0) {
      await pooled(Array.from(policyNumSet), 5, async (pnum) => {
        const enc = encodeURIComponent(pnum);

        // GET /policies/{number}
        try {
          const policy = await apiGet(client.token, BASE_V2, `/policies/${enc}`);
          if (policy) {
            for (const subj of (policy.subjects || [])) {
              rows.policies.push({
                client:             client.name,
                policy_number:      policy.number || pnum,
                subject_code:       subj.code || "",
                subject_label:      subj.label || "",
                validity_status:    subj.validityStatus || "",
                effective_date:     dt(subj.effectiveDate),
                expiration_date:    dt(subj.expirationDate),
                cancellation_date:  dt(subj.cancellation?.effectiveDate),
                cancellation_issue: dt(subj.cancellation?.issueDate),
                cancellation_notes: subj.cancellation?.notes || "",
                cancel_id:          subj.cancellation?.id || "",
                documents_count:    (subj.documents || []).length,
                sync_date:          TODAY,
              });
            }
          }
        } catch(e) { err("policies", { policy: pnum }, e); }

        // GET /policies/{number}/documents
        try {
          const pdocs = await fetchAll(client.token, `/policies/${enc}/documents`);
          for (const d of pdocs) {
            for (const subj of (d.subjects || [])) {
              rows.policy_documents.push({
                client:             client.name,
                policy_number:      pnum,
                document_id:        d._id || "",
                document_name:      d.name || "",
                issue_date:         dt(d.issueDate),
                vendor_id:          d.primaryRecordId || "",
                vendor_name:        vendorMap[d.primaryRecordId] || "",
                subject_code:       subj.code || "",
                subject_label:      subj.label || "",
                validity_status:    subj.validityStatus || "",
                effective_date:     dt(subj.effectiveDate),
                expiration_date:    dt(subj.expirationDate),
                cancellation_date:  dt(subj.cancellation?.effectiveDate),
                sync_date:          TODAY,
              });
            }
          }
        } catch(e) { err("policy_documents", { policy: pnum }, e); }

        // GET /policies/{number}/amendments
        try {
          const amendments = await fetchAll(
            client.token,
            `/policies/${enc}/amendments`
          );
          for (const a of amendments) {
            rows.policy_amendments.push({
              client:          client.name,
              amendment_id:    a._id || "",
              policy_number:   a.policyNumber || pnum,
              type:            a.type || "",
              status:          a.status || "",
              vendor_id:       a.primaryRecordId || "",
              vendor_name:     vendorMap[a.primaryRecordId] || "",
              subjects:        (a.matchingSubjects || a.subjects || [])
                               .map(s => s.label || s.code || "").join("; "),
              effective_date:  dt(a.effectiveDate),
              issue_date:      dt(a.issueDate),
              notes:           a.notes || "",
              document_id:     a.document?.id || "",
              sync_date:       TODAY,
            });
          }
        } catch(e) { err("policy_amendments", { policy: pnum }, e); }
      });
    }

    console.log(`\n  ✅ ${client.name} complete`);
    await sleep(300);
  }

  // ── WRITE ALL CSVs ─────────────────────────────────────────
  console.log(`\n${"=".repeat(60)}`);
  console.log("  Writing CSVs");
  console.log(`${"=".repeat(60)}`);

  write("workspace.csv",               rows.workspace);
  write("views.csv",                   rows.views);
  write("custom_field_definitions.csv",rows.custom_field_defs);
  write("tag_definitions.csv",         rows.tag_defs);
  write("document_type_definitions.csv",rows.doc_type_defs);
  write("context_objects.csv",         rows.context_objects);
  write("context_records.csv",         rows.context_records);
  write("context_record_attributes.csv",rows.context_record_attrs);
  write("primary_objects.csv",         rows.primary_objects);
  write("vendors.csv",                 rows.vendors);
  write("contacts.csv",                rows.contacts);
  write("vendor_attributes.csv",       rows.vendor_attrs);
  write("vendor_tags.csv",             rows.vendor_tags);
  write("documents.csv",               rows.documents);
  write("document_amendments.csv",     rows.document_amendments);
  write("request_records.csv",         rows.request_records);
  write("request_record_attributes.csv",rows.request_record_attrs);
  write("coverage_subjects.csv",       rows.coverage_subjects);
  write("requirements.csv",            rows.requirements);
  write("policies.csv",                rows.policies);
  write("policy_documents.csv",        rows.policy_documents);
  write("policy_amendments.csv",       rows.policy_amendments);

  if (rows.errors.length > 0) {
    const summary = {};
    rows.errors.forEach(e => { summary[e.stage] = (summary[e.stage] || 0) + 1; });
    console.warn(`\n⚠️  ${rows.errors.length} non-fatal errors: ${JSON.stringify(summary)}`);
    fs.writeFileSync(path.join(DATA_DIR, "sync_errors.log"), JSON.stringify(rows.errors, null, 2));
  }

  console.log("\n✅ TrustLayer sync complete.");
}

main().catch(err => {
  console.error("Fatal:", err);
  process.exit(1);
});
