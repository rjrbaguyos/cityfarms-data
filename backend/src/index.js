require("dotenv").config();
const cors = require("cors");
const express = require("express");
const db = require("./db");
const orderFormRouter = require("./routes/orderForm");

const app = express();
const port = Number(process.env.PORT || 8000);

app.use(cors());
app.use(express.json());

app.get("/health", async (_req, res) => {
  try {
    await db.query("SELECT 1");
    res.json({ ok: true, db: true });
  } catch (err) {
    res.status(500).json({ ok: false, db: false, error: err.message });
  }
});

app.get("/customers", async (_req, res) => {
  try {
    const result = await db.query(
      `SELECT id, name, display_name, account_group, sold_in_cases, active, sort_order
       FROM customers
       ORDER BY sort_order, id`
    );
    res.json(result.rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get("/products", async (_req, res) => {
  try {
    // Sandbox products table currently has id + name only
    const result = await db.query(`SELECT id, name FROM products ORDER BY id`);
    res.json(result.rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.use("/cycles", orderFormRouter);

app.listen(port, () => {
  console.log(`API listening on http://localhost:${port}`);
});
