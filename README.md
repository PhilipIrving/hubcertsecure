# CertSecure Hub

**HUB CertSecure's internal operations platform** — report generation, client management, Monday.com workspace integration, and compliance tracking across Evident and TrustLayer.

> Hosted at [philipirving.github.io/hubcertsecure](https://philipirving.github.io/hubcertsecure) · Access restricted to authorized HUB CertSecure personnel

---

## What This Is

CertSecure Hub is a single-file web application hosted on GitHub Pages. It connects directly to data synced from Evident and TrustLayer, generates compliance and engagement reports for client meetings, and manages client configuration — all without a backend server.

The app is organized into two main tabs:

- **Report Generator** — select a client, configure which reports to generate, and produce PDFs and Excel workbooks in the browser
- **Client Configuration** — add, edit, and deactivate clients; configure platform assignments, go-live dates, and producer information

---

## Repository Structure

```
hubcertsecure/
│
├── index.html                   # The entire CertSecure Hub application (single file)
│
├── config/
│   └── clients.json             # Master client list — source of truth for the app
│
├── data/
│   ├── evident/                 # Synced Evident CSV data (updated by GitHub Actions)
│   │   ├── insureds.csv
│   │   ├── coverages.csv
│   │   ├── criteria.csv
│   │   ├── custom_properties.csv
│   │   └── engagement.csv
│   └── trustlayer/              # Synced TrustLayer CSV data (updated by GitHub Actions)
│       ├── insureds.csv
│       ├── coverages.csv
│       └── criteria.csv
│
├── snapshots/
│   └── YYYY/
│       └── YYYY-MM/             # Monthly compliance snapshots (one folder per month)
│           ├── insureds.csv
│           ├── criteria.csv
│           └── engagement.csv
│
├── evident-sync/
│   └── src/                     # Python sync scripts for Evident data
│
├── trustlayer-sync/
│   └── src/                     # Python/Node sync scripts for TrustLayer data
│
├── .github/
│   └── workflows/
│       └── sync.yml             # GitHub Actions workflow — triggers data refresh
│
└── README.md                    # This file
```

---

## Architecture Overview

```
Evident API  ──────┐
                   ├──► GitHub Actions (sync.yml) ──► data/ CSVs ──► CertSecure Hub
TrustLayer API ────┘                                                        │
                                                                            │
                                                              config/clients.json
                                                                            │
                                                              snapshots/ (monthly)
```

The app has no backend. Everything runs in the browser:

1. **Data lives in this repo** as CSV files, updated automatically by GitHub Actions
2. **The app fetches CSVs** directly from the GitHub Contents API at runtime
3. **Reports are generated client-side** using ExcelJS (Excel) and the browser's print dialog (PDF)
4. **Auth is handled by Supabase** — roles and sessions are stored there, not in this repo
5. **Client config is stored in `config/clients.json`** and written back to the repo via the GitHub Contents API when changes are saved in the app

---

## Data Architecture

### Evident Clients
Data is fetched from `data/evident/` using the GitHub Contents API. The `client` column in each CSV must exactly match the `client_name` field in `config/clients.json`.

| File | Contents |
|---|---|
| `insureds.csv` | One row per entity — name, email, compliance status, active/paused flags |
| `coverages.csv` | One row per coverage line — type, expiration date |
| `criteria.csv` | One row per entity — overall compliance, non-compliance reasons (pipe-delimited) |
| `custom_properties.csv` | Custom fields per entity — contract numbers, project names, entity types |
| `engagement.csv` | Email send/open/click/bounce events per entity |

### TrustLayer Clients
Same CSV structure and column names as Evident. Data is fetched from `data/trustlayer/`. TrustLayer clients are identified by `"platform": "trustlayer"` in `clients.json`. TrustLayer data does not currently include `custom_properties.csv` or `engagement.csv`.

### Snapshot Data
Monthly snapshots live in `snapshots/YYYY/YYYY-MM/` and are used by the Year End Review, Producer Overview, and HUB-Wide Annual reports. Snapshots are point-in-time copies of the `insureds.csv`, `criteria.csv`, and `engagement.csv` files, created automatically by GitHub Actions on a monthly schedule.

---

## clients.json Reference

Located at `config/clients.json`. This is the master client list. Every client visible in the app must have an entry here.

```json
{
  "clients": [
    {
      "client_name": "ESS Companies",
      "rp_common_name": "esscompanies",
      "program_start_date": "2025-08-01",
      "go_live_date": "2025-09-15",
      "structure": "project",
      "platform": "evident",
      "producer_name": "Paul Cohen",
      "contact_name": "Clayton Hicklin",
      "active": true
    }
  ]
}
```

| Field | Required | Description |
|---|---|---|
| `client_name` | ✅ | Must exactly match the `client` column in the CSVs |
| `rp_common_name` | ✅ | Short identifier used in API calls and filenames |
| `program_start_date` | — | Date the service agreement was signed (YYYY-MM-DD) |
| `go_live_date` | — | Date the platform went live with third parties (YYYY-MM-DD) |
| `structure` | ✅ | `general` (vendors) / `project` (subcontractors) / `location` (tenants) |
| `platform` | ✅ | `evident` or `trustlayer` |
| `producer_name` | — | Referring producer — pre-fills Thank You Card and Producer Overview |
| `contact_name` | — | Client day-to-day contact — pre-fills Thank You Card |
| `active` | ✅ | `true` to show in app, `false` to hide (preferred over deletion) |

> **Never hard-delete a client from `clients.json`.** Set `"active": false` instead. This preserves historical report data and snapshot references.

---

## GitHub Actions — Data Sync

The sync workflow lives at `.github/workflows/sync.yml`. It can be triggered:

- **Manually** — from the GitHub Actions tab, or via the "Refresh Data" button in the app (requires an Access Token with `workflow` scope in Settings)
- **On a schedule** — configure a cron trigger in `sync.yml` for automatic daily or hourly refresh

### Required GitHub Secrets

| Secret | Used By | Description |
|---|---|---|
| `EVIDENT_API_TOKEN` | Evident sync | API token from Evident platform settings |
| `TRUSTLAYER_API_TOKEN` | TrustLayer sync | API token from TrustLayer platform settings |
| `GH_PAT` | Both | Personal Access Token with `repo` and `workflow` scopes for writing CSV data back to this repo |

Secrets are set in **GitHub → Settings → Secrets and variables → Actions**.

---

## Monday.com Integration

CertSecure Hub connects to the HUB CertSecure Monday.com workspace in two ways:

### 1. Workspace Setup Tool
A one-time setup tool (`monday-setup.html`) is available in this repo. Open it in Chrome, paste your Monday API token, and it will automatically create all 6 boards, groups, columns, and folder structure per the workspace spec.

Your Monday API token is found at: **Monday.com → Profile Picture → Developers → My Access Tokens**

### 2. Report URL Sync *(coming soon)*
After generating reports, a "Sync to Monday" button will push the generated report URLs directly to the `RPT:` columns on the client's row in Clients – Overview. No manual copy-pasting required.

The Monday API token is never stored in the repo — it is entered by the user at runtime and used only for that session.

---

## User Roles & Access

Authentication is handled by Supabase. User roles are stored in `raw_user_meta_data` on each user's Supabase account.

| Role | Badge Color | Permissions |
|---|---|---|
| `system_administrator` | Navy | Full access — reports, client config, user management, settings |
| `account_manager` | Blue | Reports + edit clients |
| `account_administrator` | Grey | Reports only — read-only client config |

Users are managed in the app under **Settings → Users** (System Administrator only). The Users tab requires the Supabase Edge Function `manage-users` to be deployed to the project.

---

## Settings Reference

Settings are stored in `localStorage` and persist between sessions on the same browser. They are configured in the app under **Settings → Data Source**.

| Setting | Default | Description |
|---|---|---|
| Data Owner | `PhilipIrving` | GitHub username owning this repo |
| Repository | `hubcertsecure` | Repository name |
| Branch | `main` | Branch to read data from |
| Access Token | *(blank)* | PAT for Refresh Data button — requires `workflow` scope |
| CSV Paths | `data/evident/*.csv` | Paths to each CSV file within the repo |
| TL CSV Paths | `data/trustlayer/*.csv` | TrustLayer-specific CSV paths |

---

## Reports Reference

| Report | Format | Data Source | Description |
|---|---|---|---|
| Compliance Summary | PDF | `data/` CSVs | Executive overview — compliance rate, KPIs, expiring coverage, top NC reasons |
| Compliance Detail | Excel | `data/` CSVs | Full entity-level compliance data with filtering and custom fields |
| Engagement Summary | PDF | `data/` CSVs | Email engagement overview — open rates, delivery issues, activity window |
| Engagement Detail | Excel | `data/` CSVs | Entity-level engagement data — no-COI list, no-engagement list, undeliverable emails |
| Year End Review | PDF | `snapshots/` | Monthly compliance trend chart across all snapshots for a given year |
| Producer Overview | PDF | `snapshots/` | Snapshot-based summary formatted for referring producers |
| Thank You Card | PDF | `data/` CSVs | Landscape postcard with compliance hero stats and personalized message |
| HUB-Wide Annual | PDF | `snapshots/` | Combined annual review across all Evident clients — compliance, engagement, NC trends |

---

## Adding a New Client

1. **Get the exact client name** from the Evident or TrustLayer platform — it must match the `client` column in the synced CSVs exactly
2. **Open the app → Client Configuration tab → Add Client**
3. Fill in all fields and set `platform` to `evident` or `trustlayer`
4. Click **Save Changes** — this writes the new entry to `config/clients.json` in the repo automatically
5. **Trigger a data sync** (Refresh Data button or GitHub Actions) to pull the client's CSV data
6. The client will appear in the Report Generator on next load

---

## Offboarding a Client

1. Open **Client Configuration → Edit** on the client
2. Uncheck **Active** and click Save Changes
3. The client disappears from the Report Generator but their data and snapshots are preserved

Do **not** delete the entry from `clients.json` — inactive clients may still be needed for historical Year End Reviews and snapshot reports.

---

## Development Notes

- The entire app is `index.html` — a single self-contained file with no build step or dependencies to install
- External libraries are loaded from CDN: **Supabase** (auth), **ExcelJS** (Excel generation), **PapaParse** (CSV parsing)
- All report generation is client-side — no data leaves the browser except for GitHub API calls to fetch CSVs
- To test locally, serve via a local HTTP server (e.g. `python -m http.server 8080`) — do not open as a `file://` URL as GitHub API calls will be blocked by CORS

---

## Contacts

| Role | Name | Email |
|---|---|---|
| System Administrator | Philip Irving | philip.irving@hubinternational.com |
| Program Lead | Larry | larry@hubinternational.com |

---

*HUB CertSecure · Confidential — Internal Use Only*
