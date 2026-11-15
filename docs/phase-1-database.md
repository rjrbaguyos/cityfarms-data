# Phase 1 — Database up (Express + `pg`)

**Prerequisites (step 1 — already done):**
- Docker Desktop installed and **running**
- Node.js **20+** installed

**Stack:** PostgreSQL (Docker) + Express + **`pg`** (plain SQL, no Prisma)

**Goal:** Postgres running, tables created from SQL files, sample customers/products loaded, Express API can read them.

**Done when:** You can change table SQL, re-apply, and query via `psql` or `GET /customers`.

> Excel import is **optional / later**. Focus here is sandboxing a solid table design.

---

## 2. Start Postgres

If you already completed Docker Compose earlier, skip to verifying the container.

### 2.1 Confirm Docker

```powershell
docker version
```

### 2.2 `.env` (project root)

```env
POSTGRES_USER=cityfarms_dev
POSTGRES_PASSWORD=cityfarms123
POSTGRES_DB=cityfarms
POSTGRES_PORT=5432

DATABASE_URL=postgresql://cityfarms_dev:cityfarms123@localhost:5432/cityfarms
```

Use **your** real user/password. Keep root `.env` and `backend/.env` in sync (or copy):

```powershell
Copy-Item .\.env .\backend\.env
```

### 2.3 `docker-compose.yml` (already present)

```powershell
cd "C:\Users\rjrba\Documents\CityFarms Projects\data-migration"
docker compose up -d
docker compose ps
```

### 2.4 Connectivity check

Use the user from your `.env` (example uses `cityfarms_dev`):

```powershell
docker exec -it cityfarms-pg psql -U cityfarms_dev -d cityfarms -c "SELECT version();"
```

---

## 3. Backend: Express + `pg`

### 3.1 Install packages (from `backend/`)

```powershell
cd "C:\Users\rjrba\Documents\CityFarms Projects\data-migration\backend"
npm uninstall prisma @prisma/client
npm install express cors dotenv pg
```

(If starting fresh: `npm install express cors dotenv pg` only.)

### 3.2 Project files (already scaffolded)

| File | Role |
|---|---|
| `backend/src/db.js` | `pg` connection pool |
| `backend/src/index.js` | Express API (`/health`, `/customers`, `/products`) |
| `backend/scripts/run-sql.js` | Runs a `.sql` file against Postgres |
| `db/001_init.sql` | Create tables |
| `db/002_seed.sql` | Sample customers + products |

### 3.3 How sandboxing works

1. Edit SQL in `db/001_init.sql` (add/rename columns, new tables, etc.)
2. Apply with `npm run db:init`
3. Inspect in `psql` or DBeaver
4. When you need a clean slate:

```powershell
cd "C:\Users\rjrba\Documents\CityFarms Projects\data-migration"
docker compose down -v
docker compose up -d
cd backend
npm run db:init
npm run db:seed
```

`down -v` **wipes** the database volume — fine for local experiments.

---

## 4. Create tables

```powershell
cd "C:\Users\rjrba\Documents\CityFarms Projects\data-migration\backend"
npm run db:init
```

Verify:

```powershell
docker exec -it cityfarms-pg psql -U cityfarms_dev -d cityfarms -c "\dt"
```

You should see: `customers`, `products`, `harvest_days`, `harvest_plan`, `order_lines`, `daily_customer_meta`, `daily_production`.

---

## 5. Seed sample data

```powershell
npm run db:seed
```

Check:

```powershell
docker exec -it cityfarms-pg psql -U cityfarms_dev -d cityfarms -c "SELECT id, name FROM customers ORDER BY sort_order;"
docker exec -it cityfarms-pg psql -U cityfarms_dev -d cityfarms -c "SELECT id, name, category FROM products ORDER BY sort_order;"
```

---

## 6. Verify API

```powershell
npm run dev
```

Another terminal:

```powershell
curl http://localhost:8000/health
curl http://localhost:8000/customers
curl http://localhost:8000/products
```

### Manual insert test (in `psql`)

```powershell
docker exec -it cityfarms-pg psql -U cityfarms_dev -d cityfarms
```

```sql
INSERT INTO harvest_days (harvest_date, notes)
VALUES ('2026-08-20', 'sandbox test')
RETURNING id;

INSERT INTO order_lines (harvest_day_id, customer_id, product_id, quantity, is_na)
VALUES (1, 1, 1, 22, false);

SELECT c.name, p.name, ol.quantity
FROM order_lines ol
JOIN customers c ON c.id = ol.customer_id
JOIN products p ON p.id = ol.product_id;
```

`\q` to quit.

---

## Useful commands

| Task | Command |
|---|---|
| Start DB | `docker compose up -d` (project root) |
| Stop DB | `docker compose down` |
| Wipe DB | `docker compose down -v` |
| Apply schema | `cd backend` → `npm run db:init` |
| Seed | `cd backend` → `npm run db:seed` |
| Run any SQL file | `node scripts/run-sql.js ../db/your_file.sql` |
| API | `npm run dev` |

---

## Troubleshooting

| Problem | Fix |
|---|---|
| `role "…" does not exist` | Use `POSTGRES_USER` from `.env` in `-U` |
| Auth / connection failed | Sync `backend/.env` with root `.env`; confirm container is up |
| Tables already exist / want redo | `docker compose down -v` then up + `db:init` + `db:seed` |
| Old Prisma folders | Safe to delete `backend/prisma/` — unused now |

---

## Phase 1 checklist

- [ ] Postgres container healthy
- [ ] `db/001_init.sql` applied (`\dt` shows tables)
- [ ] Seed data visible
- [ ] `/health`, `/customers`, `/products` work
- [ ] You can edit SQL, wipe, and re-apply comfortably

**Next:** Phase 3-ish — board API + React grid UI. Excel import only if/when you want historical data loaded.
