const db = require("../db");

async function listCycles() {
  const result = await db.query(
    `SELECT id, harvest_date::text AS date, notes, created_at
     FROM cycles
     ORDER BY harvest_date DESC`
  );
  return result.rows;
}

async function getCycleByDate(date) {
  const result = await db.query(
    `SELECT id, harvest_date::text AS date, notes, created_at
     FROM cycles
     WHERE harvest_date = $1`,
    [date]
  );
  return result.rows[0] || null;
}

async function createCycle(date, notes = null) {
  const result = await db.query(
    `INSERT INTO cycles (harvest_date, notes)
     VALUES ($1, $2)
     ON CONFLICT (harvest_date)
     DO UPDATE SET notes = COALESCE(EXCLUDED.notes, cycles.notes)
     RETURNING id, harvest_date::text AS date, notes, created_at`,
    [date, notes]
  );
  return result.rows[0];
}

async function getActiveCustomers() {
  const result = await db.query(
    `SELECT id, name, display_name, account_group, sold_in_cases, sort_order
     FROM customers
     WHERE active = true
     ORDER BY sort_order, id`
  );
  return result.rows;
}

async function getProducts() {
  // products currently only has id + name in the sandbox
  const result = await db.query(
    `SELECT id, name
     FROM products
     ORDER BY id`
  );
  return result.rows;
}

async function getCellsForCycle(cycleId) {
  const result = await db.query(
    `SELECT id, customer_id, product_id, quantity, is_na, pack_size, unit_price, updated_at
     FROM order_form_data
     WHERE cycle_id = $1
     ORDER BY customer_id, product_id`,
    [cycleId]
  );
  return result.rows;
}

async function getBoardByDate(date) {
  const cycle = await getCycleByDate(date);
  if (!cycle) {
    return null;
  }

  const [customers, products, cells] = await Promise.all([
    getActiveCustomers(),
    getProducts(),
    getCellsForCycle(cycle.id),
  ]);

  return {
    date: cycle.date,
    cycle_id: cycle.id,
    notes: cycle.notes,
    customers,
    products,
    cells,
  };
}

/**
 * Resolve default pack_size / unit_price from customer_product_packs.
 * If packSize is provided, prefer that row; otherwise pick the largest pack_size.
 */
async function resolvePackDefaults(customerId, productId, packSize = null) {
  if (packSize != null) {
    const exact = await db.query(
      `SELECT pack_size, unit_price
       FROM customer_product_packs
       WHERE customer_id = $1 AND product_id = $2 AND pack_size = $3`,
      [customerId, productId, packSize]
    );
    if (exact.rows[0]) {
      return {
        pack_size: Number(exact.rows[0].pack_size),
        unit_price: exact.rows[0].unit_price,
      };
    }
  }

  const fallback = await db.query(
    `SELECT pack_size, unit_price
     FROM customer_product_packs
     WHERE customer_id = $1 AND product_id = $2
     ORDER BY pack_size DESC
     LIMIT 1`,
    [customerId, productId]
  );

  if (fallback.rows[0]) {
    return {
      pack_size: Number(fallback.rows[0].pack_size),
      unit_price: fallback.rows[0].unit_price,
    };
  }

  return { pack_size: 1, unit_price: 0 };
}

async function upsertCell(cycleId, cell) {
  const customerId = Number(cell.customer_id);
  const productId = Number(cell.product_id);
  const isNa = Boolean(cell.is_na);
  const quantity = isNa ? null : cell.quantity === "" || cell.quantity === undefined ? null : cell.quantity;

  const defaults = await resolvePackDefaults(
    customerId,
    productId,
    cell.pack_size != null ? Number(cell.pack_size) : null
  );

  const packSize = cell.pack_size != null ? Number(cell.pack_size) : defaults.pack_size;
  const unitPrice = cell.unit_price != null ? cell.unit_price : defaults.unit_price;

  const result = await db.query(
    `INSERT INTO order_form_data (
       cycle_id, customer_id, product_id,
       quantity, is_na, pack_size, unit_price
     ) VALUES ($1, $2, $3, $4, $5, $6, $7)
     ON CONFLICT (cycle_id, customer_id, product_id)
     DO UPDATE SET
       quantity = EXCLUDED.quantity,
       is_na = EXCLUDED.is_na,
       pack_size = EXCLUDED.pack_size,
       unit_price = EXCLUDED.unit_price
     RETURNING id, customer_id, product_id, quantity, is_na, pack_size, unit_price, updated_at`,
    [cycleId, customerId, productId, quantity, isNa, packSize, unitPrice]
  );

  return result.rows[0];
}

async function upsertCells(date, cells) {
  const cycle = await getCycleByDate(date);
  if (!cycle) {
    return null;
  }

  const saved = [];
  for (const cell of cells) {
    saved.push(await upsertCell(cycle.id, cell));
  }
  return saved;
}

module.exports = {
  listCycles,
  getCycleByDate,
  createCycle,
  getBoardByDate,
  upsertCells,
};
