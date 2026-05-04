// ============================================================
// Shared sync utilities — smart write, timestamps, CSV helpers
// ============================================================
"use strict";

const fs   = require("fs");
const path = require("path");

// Central timestamp
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

// CSV helpers
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

// Strip volatile columns before comparing
const VOLATILE_COLS = new Set(["sync_timestamp","sync_date"]);
function stripVolatile(csvText) {
  if (!csvText) return "";
  const lines = csvText.trim().split("\n");
  if (lines.length === 0) return "";
  const headers = lines[0].split(",");
  const keepIdx = headers.map((_,i) => i).filter(i => !VOLATILE_COLS.has(headers[i].trim()));
  return lines.map(line => {
    const cols = line.split(",");
    return keepIdx.map(i => cols[i]||"").join(",");
  }).join("\n");
}

// Smart write: only overwrites the file if data actually changed.
// Returns true if file was updated, false if skipped.
function smartWrite(filePath, rows, label) {
  const newCsv    = toCsv(rows);
  const newCoreData = stripVolatile(newCsv);

  let changed = true;
  if (fs.existsSync(filePath)) {
    const existing = fs.readFileSync(filePath, "utf8");
    const existingCoreData = stripVolatile(existing);
    if (existingCoreData === newCoreData) {
      changed = false;
    }
  }

  if (changed) {
    fs.writeFileSync(filePath, newCsv);
    console.log(`✅ ${label} — ${rows.length} rows (updated)`);
  } else {
    console.log(`⏭️  ${label} — ${rows.length} rows (no change, skipped)`);
  }
  return changed;
}

// Write sync metadata — always updated so we know when each sync ran
function writeSyncMetadata(dataDir, fileChanges, syncTimestamp) {
  const metaPath = path.join(dataDir, "sync_metadata.csv");
  const existing = fs.existsSync(metaPath)
    ? fs.readFileSync(metaPath, "utf8").trim().split("\n").slice(1).map(line => {
        const [file, lastChanged, lastRan] = line.split(",");
        return { file, last_changed: lastChanged, last_ran: lastRan };
      })
    : [];

  const updated = {};
  for (const { file, last_changed, last_ran } of existing) {
    updated[file] = { file, last_changed, last_ran };
  }
  for (const { file, changed } of fileChanges) {
    updated[file] = {
      file,
      last_changed: changed ? syncTimestamp : (updated[file]?.last_changed || syncTimestamp),
      last_ran:     syncTimestamp,
    };
  }

  const rows = Object.values(updated).sort((a,b) => a.file.localeCompare(b.file));
  const csv  = ["file,last_changed,last_ran", ...rows.map(r => `${r.file},${r.last_changed},${r.last_ran}`)].join("\n");
  fs.writeFileSync(metaPath, csv);
}

module.exports = { getSyncTimestamp, getSyncDate, csvEscape, toCsv, smartWrite, writeSyncMetadata };
