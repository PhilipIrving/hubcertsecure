// ============================================================
// Google Sheets → CSV Sync
// Pulls the HUB CertSecure Notification Report from Google
// Sheets and saves it as engagement.csv for Power BI
// ============================================================

const https   = require("https");
const crypto  = require("crypto");
const fs      = require("fs");
const path    = require("path");

const DATA_DIR  = path.join(__dirname, "..", "data");
const SHEET_ID  = process.env.GOOGLE_SHEET_ID || "1FLvwmSEb2rd2-NJHl1vaDiSm4rkwWj9P3WzySJsAd2k";   // set in GitHub Actions env
const SHEET_TAB = process.env.GOOGLE_SHEET_TAB || "Email Events"; // tab name

// Map short rp_common_name codes → full client names (matches summaries/insureds tables)
const CLIENT_NAME_MAP = {
  "agequipment":       "A G Equipment Company",
  "actionplumbing":    "Action Plumbing Construction",
  "bauerfoundation":   "Bauer Foundation Corp.",
  "cpkansascity":      "Canadian Pacific Kansas City",
  "capitalroad":       "Capital Railroad Contracting, Inc.",
  "emmes":             "EMMES",
  "emerysappandsons":  "ESS Companies",
  "gartproperties":    "Gart Properties",
  "kolbgrading":       "Kolb Grading",
  "mizuhobank":        "Mizuho Bank",
  "musselmanhall":     "Musselman & Hall Contractors, LLC",
  "paragongeo":        "Paragon Geophysical Services, Inc.",
  "scandroli":         "Scandroli Construction",
  "skyline":           "Skyline Developers Construction LLC",
  "theabbeycompany":   "The Abbey Management Company",
  "trinitychemical":   "Trinity Chemical Industries LLC",
  "unitedcoal":        "United Coal Company LLC",
};

// ------------------------------------------------------------
// Google Service Account JWT Auth
// No npm packages needed — uses Node.js built-in crypto
// ------------------------------------------------------------
function base64url(buf) {
  return buf.toString("base64")
    .replace(/=/g, "")
    .replace(/\+/g, "-")
    .replace(/\//g, "_");
}

async function getAccessToken(serviceAccountJson) {
  const sa  = JSON.parse(serviceAccountJson);
  const now = Math.floor(Date.now() / 1000);

  const header  = base64url(Buffer.from(JSON.stringify({ alg: "RS256", typ: "JWT" })));
  const payload = base64url(Buffer.from(JSON.stringify({
    iss:   sa.client_email,
    scope: "https://www.googleapis.com/auth/spreadsheets.readonly",
    aud:   "https://oauth2.googleapis.com/token",
    exp:   now + 3600,
    iat:   now,
  })));

  const sign      = crypto.createSign("RSA-SHA256");
  const signingInput = `${header}.${payload}`;
  sign.update(signingInput);
  const signature = base64url(sign.sign(sa.private_key));
  const jwt       = `${signingInput}.${signature}`;

  // Exchange JWT for access token
  return new Promise((resolve, reject) => {
    const body = `grant_type=urn%3Aietf%3Aparams%3Aoauth%3Agrant-type%3Ajwt-bearer&assertion=${jwt}`;
    const req  = https.request({
      hostname: "oauth2.googleapis.com",
      path:     "/token",
      method:   "POST",
      headers:  {
        "Content-Type":   "application/x-www-form-urlencoded",
        "Content-Length": Buffer.byteLength(body),
      },
    }, (res) => {
      let data = "";
      res.on("data", c => (data += c));
      res.on("end", () => {
        try {
          const json = JSON.parse(data);
          if (json.access_token) resolve(json.access_token);
          else reject(new Error(`Token error: ${data}`));
        } catch (e) { reject(e); }
      });
    });
    req.on("error", reject);
    req.write(body);
    req.end();
  });
}

// ------------------------------------------------------------
// Fetch sheet as CSV via Google Sheets API
// ------------------------------------------------------------
function fetchSheetAsCsv(accessToken, sheetId, tabName) {
  return new Promise((resolve, reject) => {
    // URL-encode the tab name for the range parameter
    const range    = encodeURIComponent(tabName);
    const url      = `/v4/spreadsheets/${sheetId}/values/${range}`;

    https.get({
      hostname: "sheets.googleapis.com",
      path:     url,
      headers:  { Authorization: `Bearer ${accessToken}` },
    }, (res) => {
      let data = "";
      res.on("data", c => (data += c));
      res.on("end", () => {
        if (res.statusCode !== 200) {
          reject(new Error(`Sheets API ${res.statusCode}: ${data.substring(0, 200)}`));
          return;
        }
        try {
          const json = JSON.parse(data);
          resolve(json.values || []);
        } catch (e) { reject(e); }
      });
    }).on("error", reject);
  });
}

// ------------------------------------------------------------
// Convert rows array → CSV string
// ------------------------------------------------------------
function rowsToCsv(rows) {
  if (!rows?.length) return "";
  return rows.map(row =>
    row.map(cell => {
      const s = String(cell ?? "");
      return (s.includes(",") || s.includes('"') || s.includes("\n"))
        ? `"${s.replace(/"/g, '""')}"` : s;
    }).join(",")
  ).join("\n");
}

// ------------------------------------------------------------
// MAIN
// ------------------------------------------------------------
async function main() {
  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });

  const serviceAccountKey = process.env.GOOGLE_SERVICE_ACCOUNT_KEY;
  if (!serviceAccountKey) {
    console.error("❌ GOOGLE_SERVICE_ACCOUNT_KEY secret not set");
    process.exit(1);
  }
  if (!SHEET_ID) {
    console.error("❌ GOOGLE_SHEET_ID not set");
    process.exit(1);
  }

  console.log(`📊 Fetching engagement sheet (ID: ${SHEET_ID}, tab: "${SHEET_TAB}")...`);

  const token = await getAccessToken(serviceAccountKey);
  console.log("   ✅ Authenticated with Google");

  const rows = await fetchSheetAsCsv(token, SHEET_ID, SHEET_TAB);
  console.log(`   ✅ Fetched ${rows.length - 1} rows (${rows[0]?.length} columns)`);
  console.log(`   Columns: ${rows[0]?.join(", ")}`);

  // Map short client codes to full names and filter to last 90 days
  const headers = rows[0];
  const clientIdx = headers.findIndex(h => h.toLowerCase() === "client");
  const dateIdx   = headers.findIndex(h => h.toLowerCase() === "date");

  const cutoff = new Date();
  cutoff.setDate(cutoff.getDate() - 90);

  let mapped = 0;
  let filtered = 0;
  const filteredRows = [headers];

  for (let i = 1; i < rows.length; i++) {
    const row = rows[i];

    // Filter to last 90 days
    if (dateIdx >= 0) {
      const rowDate = new Date(row[dateIdx]);
      if (!isNaN(rowDate) && rowDate < cutoff) {
        filtered++;
        continue;
      }
    }

    // Map client short codes to full names
    if (clientIdx >= 0) {
      const shortCode = (row[clientIdx] || "").trim().toLowerCase();
      if (CLIENT_NAME_MAP[shortCode]) {
        row[clientIdx] = CLIENT_NAME_MAP[shortCode];
        mapped++;
      }
    }

    filteredRows.push(row);
  }

  console.log(`   ✅ Mapped ${mapped} client codes to full names`);
  console.log(`   ✅ Filtered out ${filtered} rows older than 90 days`);
  console.log(`   ✅ Keeping ${filteredRows.length - 1} recent rows`);

  const csv = rowsToCsv(filteredRows);
  fs.writeFileSync(path.join(DATA_DIR, "engagement.csv"), csv);
  console.log(`✅ engagement.csv — ${filteredRows.length - 1} rows`);
}

main().catch(err => {
  console.error("Fatal error:", err.message);
  process.exit(1);
});
