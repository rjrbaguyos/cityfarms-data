# Daily Board Skeleton — Implementation Guide

**Goal:** A customers × products matrix for one harvest day, backed by Postgres, served by Express + `pg`, shown in a React grid.

**Stack (locked):**
- Postgres (your sandbox / future prod skeleton)
- Express + `pg` (JavaScript)
- React + Vite (JavaScript / JSX)
- AG Grid Community (Excel-like grid)

**Out of scope for this skeleton:** Socket.IO realtime, auth, Excel import, production/towers rows, invoice PDFs.

Build in this order: **SQL → API (read) → UI (read-only) → API/UI (edit)**. Don’t start the React grid until `GET /days/:date/board` returns a clean payload.

---

## 0. What you’re building

```
Browser (React + AG Grid)
   │  GET/PUT JSON
   ▼
Express (board routes)
   │  SQL via pg
   ▼
harvest_days  +  order_lines
       ▲              ▲
       │              ├── customers
       │              └── products
       │                     ▲
       └─────────────────────┴── customer_product_packs (default pack/price)
```

**Mental model**
- `customers` / `products` / `customer_product_packs` = catalog (you already have these)
- `harvest_days` = one operating day (the sheet header date)
- `order_lines` = one cell on the board (day + customer + product + qty + snapshots)

---

## 1. Database: daily board tables

### 1.1 Create tables (pgAdmin Query Tool or SQL file)

Recommended file: `db/003_daily_board.sql`

```sql
CREATE TABLE IF NOT EXISTS harvest_days (
  id            SERIAL PRIMARY KEY,
  harvest_date  DATE NOT NULL UNIQUE,
  notes         TEXT,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS order_lines (
  id             SERIAL PRIMARY KEY,
  harvest_day_id INT NOT NULL REFERENCES harvest_days(id) ON DELETE CASCADE,
  customer_id    INT NOT NULL REFERENCES customers(id),
  product_id     INT NOT NULL REFERENCES products(id),

  -- What staff type in the cell
  quantity       NUMERIC(12, 3),          -- NULL if N/A or empty
  is_na          BOOLEAN NOT NULL DEFAULT false,

  -- Snapshots at save time (don’t rely on live pack table for history)
  pack_size      INT NOT NULL DEFAULT 1 CHECK (pack_size > 0),
  unit_price     NUMERIC(10, 2) NOT NULL DEFAULT 0,

  updated_at     TIMESTAMPTZ NOT NULL DEFAULT now(),

  UNIQUE (harvest_day_id, customer_id, product_id)
);

CREATE INDEX IF NOT EXISTS order_lines_day_idx
  ON order_lines (harvest_day_id);
```

**Why snapshot `pack_size` / `unit_price`?**  
If Charlie’s pack or price changes next month, Aug 20’s board/invoice must stay correct.

### 1.2 Optional: auto-update `updated_at`

```sql
CREATE OR REPLACE FUNCTION set_updated_at()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS order_lines_set_updated_at ON order_lines;
CREATE TRIGGER order_lines_set_updated_at
  BEFORE UPDATE ON order_lines
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();
```

### 1.3 Seed one practice day (manual)

```sql
INSERT INTO harvest_days (harvest_date, notes)
VALUES (CURRENT_DATE, 'sandbox board')
ON CONFLICT (harvest_date) DO NOTHING;

-- Example cell: Charlie's + Basil 0.75oz
INSERT INTO order_lines (
  harvest_day_id, customer_id, product_id,
  quantity, is_na, pack_size, unit_price
)
SELECT
  d.id,
  c.id,
  p.id,
  22,
  false,
  COALESCE(cpp.pack_size, 1),
  COALESCE(cpp.unit_price, 0)
FROM harvest_days d
JOIN customers c ON c.name = 'CHARLIE''S PRODUCE'
JOIN products p ON p.name = 'Basil 0.75oz'
LEFT JOIN customer_product_packs cpp
  ON cpp.customer_id = c.id AND cpp.product_id = p.id
WHERE d.harvest_date = CURRENT_DATE
ON CONFLICT (harvest_day_id, customer_id, product_id)
DO UPDATE SET
  quantity = EXCLUDED.quantity,
  is_na = EXCLUDED.is_na,
  pack_size = EXCLUDED.pack_size,
  unit_price = EXCLUDED.unit_price;
```

If a customer has **multiple** pack sizes for one product, pick explicitly:

```sql
AND cpp.pack_size = 3
```

### 1.4 SQL check: “matrix-ready” query

Use your renamed tables (`cycles`, `order_form_data`):

```sql
SELECT
  c.display_name AS customer,
  p.name AS product,
  ofd.quantity,
  ofd.is_na,
  ofd.pack_size,
  ofd.unit_price,
  ofd.quantity * ofd.unit_price AS line_total
FROM order_form_data ofd
JOIN cycles cy ON cy.id = ofd.cycle_id
JOIN customers c ON c.id = ofd.customer_id
JOIN products p ON p.id = ofd.product_id
WHERE cy.harvest_date = CURRENT_DATE
ORDER BY c.sort_order, c.id, p.id;
```

You’re ready for the API when this returns sensible rows (e.g. Charlie’s / Basil 0.75oz / 22).

---

## 2. Backend: board API

Keep routes thin; put SQL in small helpers.

### 2.1 Suggested files

```
backend/src/
  index.js
  db.js
  routes/
    board.js          ← mount at /days
  services/
    boardService.js   ← SQL for load/upsert
```

### 2.2 Endpoints (skeleton)

| Method | Path | Purpose |
|---|---|---|
| `GET` | `/days` | List harvest dates |
| `POST` | `/days` | Create empty day `{ "date": "2026-11-16" }` |
| `GET` | `/days/:date/board` | Full matrix payload |
| `PUT` | `/days/:date/cells` | Upsert one or many cells |

Defer PO # / packaged / towers until the matrix edit loop works.

### 2.3 Board JSON shape (recommended)

Return **axes + sparse cells** (not a 2D array). The UI builds the grid.

```json
{
  "date": "2026-11-16",
  "harvest_day_id": 1,
  "customers": [
    {
      "id": 11,
      "name": "CHARLIE'S PRODUCE",
      "display_name": "Charlie's Produce",
      "sold_in_cases": true,
      "sort_order": 1
    }
  ],
  "products": [
    { "id": 1, "name": "Basil 0.75oz", "sort_order": 1 }
  ],
  "cells": [
    {
      "customer_id": 11,
      "product_id": 1,
      "quantity": 22,
      "is_na": false,
      "pack_size": 3,
      "unit_price": "10.50"
    }
  ]
}
```

**Sparse cells:** omit empty customer×product pairs. The UI shows blank until edited.

### 2.4 `GET /days/:date/board` — SQL sketch

```sql
-- 1) resolve day
SELECT id, harvest_date::text AS date
FROM harvest_days
WHERE harvest_date = $1;

-- 2) active customers / products (board axes)
SELECT id, name, display_name, sold_in_cases, sort_order
FROM customers
WHERE active = true
ORDER BY sort_order, id;

SELECT id, name, sort_order
FROM products
ORDER BY id;  -- add sort_order when you have it

-- 3) cells for that day
SELECT customer_id, product_id, quantity, is_na, pack_size, unit_price
FROM order_lines
WHERE harvest_day_id = $1;
```

Assemble in JS:

```js
res.json({
  date: day.date,
  harvest_day_id: day.id,
  customers,
  products,
  cells,
});
```

### 2.5 `PUT /days/:date/cells` — upsert rules

Body (single or batch):

```json
{
  "cells": [
    {
      "customer_id": 11,
      "product_id": 1,
      "quantity": 22,
      "is_na": false
    }
  ]
}
```

**Server logic (recommended):**

1. Resolve `harvest_day_id` from `:date` (404 if missing).
2. For each cell:
   - If `is_na === true` → store `quantity = NULL`, `is_na = true`.
   - If quantity cleared → either delete the row **or** set `quantity = NULL` (pick one rule and stick to it). Recommended v1: **upsert with NULL quantity** = empty cell.
3. Resolve pack/price defaults from `customer_product_packs`:
   - Prefer a single default pack per customer+product.
   - If multiple packs exist and client didn’t send `pack_size`, pick the pack you consider default (e.g. largest case pack, or add `is_default` later).
4. Upsert:

```sql
INSERT INTO order_lines (
  harvest_day_id, customer_id, product_id,
  quantity, is_na, pack_size, unit_price
) VALUES ($1,$2,$3,$4,$5,$6,$7)
ON CONFLICT (harvest_day_id, customer_id, product_id)
DO UPDATE SET
  quantity = EXCLUDED.quantity,
  is_na = EXCLUDED.is_na,
  pack_size = COALESCE(EXCLUDED.pack_size, order_lines.pack_size),
  unit_price = COALESCE(EXCLUDED.unit_price, order_lines.unit_price),
  updated_at = now()
RETURNING *;
```

5. Return the saved cell(s) so the UI can confirm.

### 2.6 `POST /days` — create empty day

```sql
INSERT INTO harvest_days (harvest_date)
VALUES ($1)
ON CONFLICT (harvest_date) DO UPDATE SET harvest_date = EXCLUDED.harvest_date
RETURNING id, harvest_date::text AS date;
```

Do **not** pre-create every customer×product line. Empty board = day row + zero cells.

### 2.7 Fix `/products` to match your real columns

Your sandbox `products` currently has mainly `id` + `name`. Until you add more columns, keep the query aligned:

```sql
SELECT id, name FROM products ORDER BY id;
```

Don’t select `category` / `unit_label` until those columns exist (your current `index.js` will error otherwise).

### 2.8 Smoke-test with curl

```powershell
curl http://localhost:8000/days
curl -X POST http://localhost:8000/days -H "Content-Type: application/json" -d "{\"date\":\"2026-11-16\"}"
curl http://localhost:8000/days/2026-11-16/board
curl -X PUT http://localhost:8000/days/2026-11-16/cells -H "Content-Type: application/json" -d "{\"cells\":[{\"customer_id\":11,\"product_id\":1,\"quantity\":22,\"is_na\":false}]}"
```

---

## 3. Frontend: read-only board first

### 3.1 Scaffold

From project root:

```powershell
npm create vite@latest frontend -- --template react
cd frontend
npm install
npm install ag-grid-community ag-grid-react
```

Dev proxy (optional) in `vite.config.js`:

```js
export default defineConfig({
  plugins: [react()],
  server: {
    proxy: {
      '/api': {
        target: 'http://localhost:8000',
        changeOrigin: true,
        rewrite: (path) => path.replace(/^\/api/, ''),
      },
    },
  },
});
```

Then fetch `/api/days/...` from the UI.

### 3.2 Page structure

One page is enough for the skeleton:

```
frontend/src/
  App.jsx
  api/board.js          ← fetch helpers
  pages/OrderBoard.jsx  ← date picker + grid
  utils/boardMatrix.js  ← cells[] → row data for AG Grid
```

### 3.3 Convert API payload → grid rows

AG Grid wants **row objects**, not a sparse cell list.

```js
// One row per customer; one field per product id
function toRowData(board) {
  const cellMap = new Map(
    board.cells.map((c) => [`${c.customer_id}:${c.product_id}`, c])
  );

  return board.customers.map((customer) => {
    const row = {
      customer_id: customer.id,
      customer_name: customer.display_name || customer.name,
    };

    for (const product of board.products) {
      const cell = cellMap.get(`${customer.id}:${product.id}`);
      if (!cell) {
        row[`p_${product.id}`] = '';
      } else if (cell.is_na) {
        row[`p_${product.id}`] = 'N/A';
      } else if (cell.quantity == null) {
        row[`p_${product.id}`] = '';
      } else {
        row[`p_${product.id}`] = Number(cell.quantity);
      }
    }
    return row;
  });
}

function toColumnDefs(board) {
  return [
    {
      field: 'customer_name',
      headerName: 'Store',
      pinned: 'left',
      editable: false,
      minWidth: 180,
    },
    ...board.products.map((p) => ({
      field: `p_${p.id}`,
      headerName: p.name,
      editable: true, // turn on in edit phase
      minWidth: 100,
    })),
  ];
}
```

### 3.4 Read-only UI flow

1. Date input (type=`date`)
2. On change / Load → `GET /days/:date/board`
3. If 404 → button “Create day” → `POST /days` → reload board
4. Render `<AgGridReact rowData={...} columnDefs={...} />`

### 3.5 Edit phase (after read-only works)

On cell value changed:

```text
user edits cell
  → parse "" | "N/A" | number
  → optimistic update in React state
  → PUT /days/:date/cells
  → on failure, reload board / revert
```

Parse rules:

| Typed value | Send |
|---|---|
| empty | `{ quantity: null, is_na: false }` |
| `N/A` / `n/a` | `{ quantity: null, is_na: true }` |
| `22` | `{ quantity: 22, is_na: false }` |

Include `customer_id` from the row; `product_id` from the column field (`p_12` → `12`).

### 3.6 Totals (client-side v1)

- **Row $ total:** sum `qty * unit_price` using cell map (need price in cells or a parallel lookup).
- **Column sold total:** sum quantities where `!is_na`.

For skeleton, column unit totals are enough; $ totals can wait until prices are filled.

---

## 4. Recommended implementation sequence

### Step A — SQL only (½ day)
- [ ] Create `harvest_days` + `order_lines`
- [ ] Insert one day + a few lines using pack defaults
- [ ] Run the join query; confirm readability

### Step B — Read API (½–1 day)
- [ ] `POST /days`, `GET /days`, `GET /days/:date/board`
- [ ] curl the board JSON
- [ ] Fix `/products` query to match real columns

### Step C — React read-only (1–2 days)
- [ ] Vite React app + AG Grid
- [ ] Date picker + load board
- [ ] Matrix renders customers × products

### Step D — Edit loop (1–2 days)
- [ ] `PUT /days/:date/cells` with pack/price snapshot
- [ ] Grid edits persist and survive refresh
- [ ] N/A + empty cell behavior agreed with ops

### Step E — Later (not skeleton)
- PO # column / `daily_customer_meta`
- Packaged / extra rows
- Socket.IO multi-user sync
- Auth

---

## 5. Design choices (stick to these unless you have a reason)

| Topic | Recommendation |
|---|---|
| Empty cells | No `order_lines` row **or** row with `quantity NULL` — prefer **no row** until first edit, then keep row |
| N/A | `is_na = true`, `quantity NULL` |
| Multiple packs | Snapshot chosen `pack_size` on the line; UI can later offer a pack picker |
| Price source | Default from `customer_product_packs`; always store on `order_lines` |
| Board axes | All `active` customers × all products (hide inactive customers) |
| IDs vs names in API | IDs in writes; names only for display |
| Wide SQL table | Never — don’t create columns per product |

---

## 6. Done when

- [ ] You can create a day and open it in the browser as a matrix
- [ ] Editing a cell writes `order_lines` and reloads correctly
- [ ] N/A and blank behave consistently
- [ ] Pack size + unit price are stored on the line when saved
- [ ] Adding a product/customer doesn’t require schema changes — only new catalog rows

---

## 7. How this feeds prod

Keep evolving tables in the sandbox by hand, but whenever the skeleton stabilizes:

```powershell
docker exec -i cityfarms-pg pg_dump -U cityfarms_dev -d cityfarms --schema-only > db/schema_snapshot.sql
```

Or maintain numbered files (`003_daily_board.sql`, …) that match what you created in pgAdmin.

The React/Express code should talk only to this relational shape — not Excel cell positions.
