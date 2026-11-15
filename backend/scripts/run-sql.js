/**
 * Run a .sql file against DATABASE_URL.
 * Usage: node scripts/run-sql.js ../db/001_init.sql
 */
require("dotenv").config();
const fs = require("fs");
const path = require("path");
const { Pool } = require("pg");

async function main() {
  const fileArg = process.argv[2];
  if (!fileArg) {
    console.error("Usage: node scripts/run-sql.js <path-to.sql>");
    process.exit(1);
  }

  const sqlPath = path.resolve(process.cwd(), fileArg);
  const sql = fs.readFileSync(sqlPath, "utf8");
  const pool = new Pool({ connectionString: process.env.DATABASE_URL });

  try {
    await pool.query(sql);
    console.log(`Applied ${sqlPath}`);
  } finally {
    await pool.end();
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
