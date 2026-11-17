const express = require("express");
const boardService = require("../services/boardService");

const router = express.Router();

function isValidDate(value) {
  return /^\d{4}-\d{2}-\d{2}$/.test(value);
}

/** GET /cycles — list all cycles */
router.get("/", async (_req, res) => {
  try {
    const cycles = await boardService.listCycles();
    res.json(cycles);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/** POST /cycles — create (or return) a cycle { date, notes? } */
router.post("/", async (req, res) => {
  try {
    const { date, notes } = req.body || {};
    if (!date || !isValidDate(date)) {
      return res.status(400).json({ error: "Body must include date as YYYY-MM-DD" });
    }
    const cycle = await boardService.createCycle(date, notes ?? null);
    res.status(201).json(cycle);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/** GET /cycles/:date/board — full matrix payload */
router.get("/:date/board", async (req, res) => {
  try {
    const { date } = req.params;
    if (!isValidDate(date)) {
      return res.status(400).json({ error: "date must be YYYY-MM-DD" });
    }

    const board = await boardService.getBoardByDate(date);
    if (!board) {
      return res.status(404).json({ error: `No cycle for ${date}` });
    }
    res.json(board);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/**
 * PUT /cycles/:date/cells
 * Body: { cells: [{ customer_id, product_id, quantity?, is_na?, pack_size?, unit_price? }] }
 */
router.put("/:date/cells", async (req, res) => {
  try {
    const { date } = req.params;
    if (!isValidDate(date)) {
      return res.status(400).json({ error: "date must be YYYY-MM-DD" });
    }

    const cells = req.body?.cells;
    if (!Array.isArray(cells) || cells.length === 0) {
      return res.status(400).json({ error: "Body must include a non-empty cells array" });
    }

    for (const cell of cells) {
      if (cell.customer_id == null || cell.product_id == null) {
        return res.status(400).json({ error: "Each cell needs customer_id and product_id" });
      }
    }

    const saved = await boardService.upsertCells(date, cells);
    if (!saved) {
      return res.status(404).json({ error: `No cycle for ${date}` });
    }
    res.json({ date, cells: saved });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
