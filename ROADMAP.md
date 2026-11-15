# CityFarms Order Board — Development Roadmap

LAN Option 1: self-hosted PostgreSQL + custom API + React spreadsheet-style UI.

This document is the project guide: architecture, schema direction, phased plan, and how to build/operate it. Follow phases in order; each phase should leave something you can run and demo.

---

## 1. Goals

**Build an internal order-board web app** (inspired by the current Excel number board) that:

- Looks and feels like the customers × products matrix
- Supports **multiple concurrent users** editing on the LAN
- Updates in **near real time** across open browsers
- Lets you **add products/customers without remapping scripts**
- Becomes the source of truth for **invoice automation** and reporting later

**Non-goals (for v1):** bulk Excel data migration, public internet access, mobile-native apps, Google-Sheets-level live cursors, offline-first sync.

> The repo folder is named `data-migration`, but **migrating old Excel files is not a priority**. Design the DB and app first; import later only if useful.

---

## 2. Constraints

| Constraint | Implication |
|---|---|
| Internal / LAN only | Host everything on a local always-on machine; no cloud DB required |
| Always-on host required | One dedicated PC/mini-PC/NAS/VM must stay powered during work hours |
| Excel is the current workflow | App should match that UX; importing old sheets is optional later |
| Scripts break on cell moves | Store relational rows (`customer` + `product` + `date`), not cell addresses |

---

## 3. Target architecture

```
[ Staff browsers on LAN ]
          |
          |  HTTP + WebSocket
          v
[ App host — always on ]
   ├── React static UI (Vite build)
   ├── API (Node.js / Express)  — REST + WebSocket
   └── PostgreSQL 16
```

**Recommended stack (pin these unless you have a strong reason not to):**

| Layer | Choice | Why |
|---|---|---|
| Database | PostgreSQL 16 (Docker) | Multi-user, durable, standard |
| API | **Node.js + Express (JavaScript)** | Familiar routing/middleware |
| DB access | **`pg`** (node-postgres) | Plain SQL — easy to sandbox and inspect |
| Schema | **SQL files in `db/`** | Edit tables directly; re-apply when experimenting |
| Realtime | **Socket.IO** (or `ws`) on the API | Push cell/row patches to other clients |
| Frontend | **React + JavaScript + Vite** | Fast UI iteration; JSX without TypeScript |
| Grid | **AG Grid Community** (or Handsontable) | Excel-like edit UX |
| Auth (v1) | Shared LAN login or simple user table + JWT | Keep simple; tighten later |
| Hosting | Docker Compose on the LAN host | One-command start of DB + API + UI |

---

## 4. Data model (conceptual)

Do **not** store the board as a wide spreadsheet table. Store facts as rows.

### Entities

1. **`customers`** — Charlie’s Produce, DiTomaso’s, CS Muldoon, FM Wasilla, etc.
2. **`products`** — Basil 0.75 oz, Arugula 4.0 oz, Mint 0.5 oz, etc.
3. **`harvest_days`** — one row per operating date (sheet header date)
4. **`harvest_plan`** — towers to harvest by category for that day
5. **`order_lines`** — one cell of the matrix: day + customer + product + quantity / N/A
6. **`daily_customer_meta`** — PO # (and later other per-customer-day fields)
7. **`daily_production`** — ACTUAL UNITS PACKAGED (and later bags/clamshells if you store them)

### Computed (usually don’t store)

- TOTAL SOLD TODAY → `SUM(order_lines.quantity)` per product
- EXTRA → packaged − sold
- Customer TOTALS ($) → `SUM(qty * unit_price)`
- TOTAL BAGS / CLAMSHELLS → derive from rules, or store in `daily_production` if they are manually entered

### Draft SQL

```sql
CREATE TABLE customers (
  id            SERIAL PRIMARY KEY,
  name          TEXT NOT NULL UNIQUE,
  account_group TEXT,                 -- Charlie's, Carrs, Fred Meyer, etc.
  sold_in_cases BOOLEAN NOT NULL DEFAULT false,
  active        BOOLEAN NOT NULL DEFAULT true,
  sort_order    INT NOT NULL DEFAULT 0
);

CREATE TABLE products (
  id            SERIAL PRIMARY KEY,
  name          TEXT NOT NULL UNIQUE,
  category      TEXT,                 -- Basil, Greens, Herbs, Bulk
  unit_label    TEXT NOT NULL,
  unit_price    NUMERIC(10,2) NOT NULL DEFAULT 0,
  active        BOOLEAN NOT NULL DEFAULT true,
  sort_order    INT NOT NULL DEFAULT 0
);

CREATE TABLE harvest_days (
  id            SERIAL PRIMARY KEY,
  harvest_date  DATE NOT NULL UNIQUE,
  notes         TEXT
);

CREATE TABLE harvest_plan (
  harvest_day_id INT NOT NULL REFERENCES harvest_days(id) ON DELETE CASCADE,
  category       TEXT NOT NULL,
  towers         NUMERIC(12,3) NOT NULL,
  PRIMARY KEY (harvest_day_id, category)
);

CREATE TABLE order_lines (
  id             SERIAL PRIMARY KEY,
  harvest_day_id INT NOT NULL REFERENCES harvest_days(id) ON DELETE CASCADE,
  customer_id    INT NOT NULL REFERENCES customers(id),
  product_id     INT NOT NULL REFERENCES products(id),
  quantity       NUMERIC(12,3),
  is_na          BOOLEAN NOT NULL DEFAULT false,
  unit_price     NUMERIC(10,2),
  UNIQUE (harvest_day_id, customer_id, product_id)
);

CREATE TABLE daily_customer_meta (
  harvest_day_id INT NOT NULL REFERENCES harvest_days(id) ON DELETE CASCADE,
  customer_id    INT NOT NULL REFERENCES customers(id),
  po_number      TEXT,
  PRIMARY KEY (harvest_day_id, customer_id)
);

CREATE TABLE daily_production (
  harvest_day_id   INT NOT NULL REFERENCES harvest_days(id) ON DELETE CASCADE,
  product_id       INT NOT NULL REFERENCES products(id),
  units_packaged   NUMERIC(12,3) NOT NULL DEFAULT 0,
  bags_ordered     NUMERIC(12,3),
  clamshells_ordered NUMERIC(12,3),
  PRIMARY KEY (harvest_day_id, product_id)
);
```

**Invoice scripts** join these tables by IDs/names/dates — never by Excel cell positions.

---

## 5. Repository layout (target)

```
data-migration/
├── ROADMAP.md                 ← this file
├── docker-compose.yml         ← postgres (+ later api/ui)
├── .env.example
├── db/
│   ├── 001_init.sql           ← create tables (edit this to sandbox)
│   └── 002_seed.sql           ← sample customers/products
├── backend/
│   ├── src/
│   │   ├── index.js           ← Express entry
│   │   ├── db.js              ← pg pool
│   │   ├── routes/
│   │   ├── ws/
│   │   └── services/
│   ├── scripts/
│   │   └── run-sql.js         ← apply .sql files
│   ├── package.json
│   └── Dockerfile
├── frontend/
│   ├── src/
│   │   ├── pages/OrderBoard.jsx
│   │   ├── api/
│   │   └── ws/
│   ├── package.json
│   └── Dockerfile
└── docs/
    ├── phase-1-database.md
    └── runbook.md
```

You can start with backend + frontend folders only; add Docker when the always-on host is ready.

---

## 6. Phased roadmap

### Phase 0 — Decisions & host (½–1 day)

**Do:**
- Pick the always-on LAN machine (mini-PC, old desktop, NAS with Docker, or VM)
- Confirm OS (Windows is fine; Linux/WSL often easier for Docker)
- Agree stack: Node (Express + `pg`) + React + Postgres (as above)
- Create Git repo / keep working in this project folder

**Done when:** You know which machine will run Postgres 24/7 (or during work hours) and who administers it.

---

### Phase 1 — Database up (1–2 days)

**Do:**
1. Install Docker and Node 20+
2. Start Postgres via Docker Compose
3. Scaffold Express + `pg`
4. Apply `db/001_init.sql`, seed with `db/002_seed.sql`
5. Verify with `psql` and `/customers` `/products`
6. Sandbox: edit SQL, wipe volume if needed, re-apply

**Detailed walkthrough:** [`docs/phase-1-database.md`](docs/phase-1-database.md)

**Done when:** You can comfortably change table structure in SQL and query it from Express.

---

### Phase 2 — (Optional) Excel import — skip for now

Only if you later want historical sheets in Postgres. Not required to build the app.

---

### Phase 3 — Read API + matrix view (3–5 days)

**Do:**
1. Expand Express routes for days/board (using `pg` + SQL)
2. Endpoints (minimum):
   - `GET /health`
   - `GET /customers`, `GET /products`
   - `GET /days` / `GET /days/{date}`
   - `GET /days/{date}/board` → payload shaped for the grid
3. Scaffold React + Vite (JavaScript / JSX)
4. Build **Order Board** page:
   - Date picker
   - Matrix grid (read-only first)
   - Show totals row(s) from API or client-side sums
5. Run API + UI on your laptop against LAN/local Postgres

**Board payload shape (example):**
```json
{
  "date": "2026-08-20",
  "customers": [{"id": 1, "name": "Charlie's Produce", "sort_order": 1}],
  "products": [{"id": 1, "name": "Basil 0.75 oz.", "sort_order": 1}],
  "cells": [
    {"customer_id": 1, "product_id": 1, "quantity": 22, "is_na": false}
  ],
  "customer_meta": [{"customer_id": 1, "po_number": "3189481"}],
  "production": [{"product_id": 1, "units_packaged": 464}],
  "harvest_plan": [{"category": "Basil", "towers": 28}]
}
```

**Done when:** Opening the app shows the same board as Excel for an imported day (read-only).

---

### Phase 4 — Editing + persistence (3–5 days)

**Do:**
1. Enable cell editing in AG Grid
2. On cell change → `PUT /days/{date}/cells` (upsert `order_lines`)
3. Support editing:
   - quantities
   - N/A toggle (or type `N/A`)
   - PO #
   - units packaged
   - towers (optional in v1)
4. Optimistic UI: update grid immediately; roll back on API error
5. Add `updated_at` / optional `version` for conflict detection later
6. Admin screens (simple forms): add/edit customer, add/edit product, set prices, reorder sort

**Done when:** Two browsers can each edit different cells and both see saved values after refresh.

---

### Phase 5 — Near real-time sync (2–4 days)

**Do:**
1. WebSocket endpoint: `WS /ws/board/:date` (Socket.IO attached to the Express HTTP server is the simplest path)
2. After a successful write, broadcast a small patch:
   ```json
   {"type": "cell_updated", "customer_id": 1, "product_id": 2, "quantity": 10, "is_na": false}
   ```
3. Clients subscribed to that date apply the patch to the grid
4. On tab focus / reconnect, re-fetch full board (safety net)
5. Optional: show “last saved” / connection status in the UI

**Done when:** User A edits a cell; User B sees it update within ~1 second without refresh.

---

### Phase 6 — Auth, hardening, LAN deploy (2–4 days)

**Do:**
1. Simple auth (pick one):
   - Shared staff password + JWT, or
   - User accounts table (admin / editor / viewer)
2. Lock API to LAN bind address; do not port-forward to the internet
3. Docker Compose: `postgres` + `api` + `web` (nginx serving built React)
4. `.env` for DB password, JWT secret
5. Write `docs/runbook.md`: start, stop, backup, restore
6. Nightly `pg_dump` backup to another drive/NAS

**Done when:** Staff open `http://<lan-host>/` , log in, and use the board during a real harvest day.

---

### Phase 7 — Invoices & automation (ongoing)

**Do only after the board is trusted:**
1. Price lists (global and/or per customer)
2. `GET /days/{date}/invoice/{customer_id}` → line items for PDF/CSV
3. Replace cell-position Excel macros/scripts with queries on `order_lines`
4. Optional: email/export hooks, weekly summaries, waste/extra reports

**Done when:** Creating an invoice does not care what column Basil is in.

---

## 7. General build instructions

### A. Local development (laptop)

1. Install: Git, Node 20+, Docker Desktop
2. Start Postgres (Docker command in Phase 1)
3. Backend:
   ```bash
   cd backend
   npm install
   npm run db:init
   npm run db:seed
   npm run dev
   ```
4. Frontend (later):
   ```bash
   cd frontend
   npm install
   npm run dev
   ```
5. Point frontend API base URL to `http://localhost:8000`

### C. Day-to-day feature workflow

1. Edit `db/*.sql` (or add a new numbered SQL file) and apply
2. Add/adjust API endpoint (`pg` queries)
3. Wire UI to endpoint
4. Test with two browser windows (concurrency)

### D. LAN host deployment (summary)

1. Install Docker on the always-on machine
2. Copy project; set `.env` secrets
3. `docker compose up -d`
4. Confirm other PCs can reach `http://<host-ip>`
5. Schedule backups

---

## 8. API surface (v1 checklist)

| Method | Path | Purpose |
|---|---|---|
| GET | `/health` | Liveness |
| GET | `/customers` | List/manage stores |
| POST/PATCH | `/customers` | Add/update store |
| GET | `/products` | List/manage SKUs |
| POST/PATCH | `/products` | Add/update SKU |
| GET | `/days` | List harvest dates |
| POST | `/days` | Create empty day board |
| GET | `/days/{date}/board` | Full matrix payload |
| PUT | `/days/{date}/cells` | Upsert one or many cells |
| PUT | `/days/{date}/customer-meta` | PO # etc. |
| PUT | `/days/{date}/production` | Packaged / bags / clamshells |
| WS | `/ws/board/{date}` | Live patches |

---

## 9. Testing checklist

- [ ] Import matches Excel for at least 3 dates
- [ ] N/A cells round-trip correctly
- [ ] 0 vs blank behavior matches operations expectations
- [ ] Adding a new product appears as a new column without code changes
- [ ] Adding a new customer appears as a new row without code changes
- [ ] Two users editing different cells both persist
- [ ] Realtime patch appears on second client
- [ ] Restart Docker; data still present
- [ ] Backup restore works on a spare DB

---

## 10. Risks & decisions to watch

| Risk | Mitigation |
|---|---|
| Host PC sleeps/crashes | Disable sleep; UPS; backups |
| Excel import edge cases (merged cells, duplicate day layouts A/B) | Start with one sheet pattern; log unparsed rows |
| Price mismatches vs Excel `$` totals | Snapshot `unit_price` on each `order_line` at edit/import time |
| Simultaneous edit of same cell | Last-write-wins in v1; add version column if needed |
| Scope creep (full ERP) | Ship board edit + import first; invoices second |

---

## 11. Suggested milestone calendar

| Week | Focus |
|---|---|
| 1 | Phase 0–1: host + Postgres + SQL schema sandbox |
| 2 | Phase 3: read-only board in browser |
| 3 | Phase 4: editing + admin for products/customers |
| 4 | Phase 5–6: WebSockets + LAN Docker deploy + backups |
| 5+ | Phase 7: invoices/reporting; optional Excel import |

Adjust pace for part-time work; keep each phase demoable.

---

## 12. Immediate next actions

1. Finish Phase 1: `npm run db:init` + `npm run db:seed` + API smoke test
2. Sandbox schema in `db/001_init.sql` until the model feels right
3. Build board read API + React grid (Phase 3)
4. Add editing + realtime
5. Deploy on the always-on LAN host

---

## 13. Success definition

You can throw away cell-address logic. A harvest day is edited in the browser like a sheet; Postgres holds customers, products, and quantities; another user sees updates live; invoices are generated from queries like “all non-N/A lines for Charlie’s on 2026-08-20,” regardless of column order.
