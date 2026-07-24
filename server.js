/*
 * Bespoke Mattress Price Calculator — server
 * Serves the calculator (public/index.html) AND a tiny API backed by Postgres.
 * Every saved order lands in the `orders` table = the "Invoiced Orders" log.
 *
 * Env:
 *   DATABASE_URL  — provided automatically by Railway's Postgres plugin
 *   PGSSL         — set to "true" only if you connect over Postgres' PUBLIC url
 *   PORT          — provided automatically by Railway
 */
const express = require("express");
const path = require("path");
const { Pool } = require("pg");

const app = express();
app.use(express.json({ limit: "1mb" }));
app.use(express.static(path.join(__dirname, "public")));

const hasDb = !!process.env.DATABASE_URL;
const pool = hasDb
  ? new Pool({
      connectionString: process.env.DATABASE_URL,
      ssl: process.env.PGSSL === "true" ? { rejectUnauthorized: false } : false,
    })
  : null;

async function initDb() {
  if (!pool) { console.warn("No DATABASE_URL set — API will report unavailable."); return; }
  await pool.query(`
    CREATE TABLE IF NOT EXISTS orders (
      id          SERIAL PRIMARY KEY,
      order_no    TEXT NOT NULL,
      model       TEXT,
      size        TEXT,
      depth       TEXT,
      calc        NUMERIC,
      agreed      NUMERIC,
      carriage    TEXT,
      lines       JSONB,
      created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
    );
  `);
  await pool.query(`ALTER TABLE orders ADD COLUMN IF NOT EXISTS diagram TEXT`);
  console.log("Database ready.");
}

// health: the front-end pings this to decide DB vs local-storage mode
app.get("/api/health", async (_req, res) => {
  if (!pool) return res.status(503).json({ ok: false });
  try { await pool.query("SELECT 1"); res.json({ ok: true }); }
  catch (e) { res.status(503).json({ ok: false }); }
});

// list — newest first
app.get("/api/orders", async (_req, res) => {
  if (!pool) return res.status(503).json([]);
  try {
    const { rows } = await pool.query(
      `SELECT id, order_no AS "order", created_at AS ts, model, size, depth, calc, agreed, carriage, lines, diagram
         FROM orders ORDER BY created_at DESC LIMIT 2000`
    );
    res.json(rows);
  } catch (e) { console.error(e); res.status(500).json([]); }
});

// save one order
app.post("/api/orders", async (req, res) => {
  if (!pool) return res.status(503).json({ error: "no database" });
  const b = req.body || {};
  if (!b.order) return res.status(400).json({ error: "order number required" });
  try {
    const { rows } = await pool.query(
      `INSERT INTO orders (order_no, model, size, depth, calc, agreed, carriage, lines, diagram)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING id`,
      [b.order, b.model || null, b.size || null, b.depth || null,
       b.calc == null ? null : b.calc, b.agreed == null ? null : b.agreed,
       b.carriage || null, JSON.stringify(b.lines || []), b.diagram || null]
    );
    res.json({ ok: true, id: rows[0].id });
  } catch (e) { console.error(e); res.status(500).json({ error: "save failed" }); }
});

// delete one
app.delete("/api/orders/:id", async (req, res) => {
  if (!pool) return res.status(503).json({ error: "no database" });
  try { await pool.query("DELETE FROM orders WHERE id = $1", [req.params.id]); res.json({ ok: true }); }
  catch (e) { console.error(e); res.status(500).json({ error: "delete failed" }); }
});

// ---- Order-app bridge (server-side; key + order-app URL never reach the browser) ----
const ORDER_APP_URL = (process.env.ORDER_APP_URL || "").replace(/\/$/, "");
const PRICING_API_KEY = process.env.PRICING_API_KEY || "";
const lookupEnabled = !!(ORDER_APP_URL && PRICING_API_KEY);

app.get("/api/order/enabled", (_req, res) => res.json({ enabled: lookupEnabled }));

app.get("/api/order/search", async (req, res) => {
  if (!lookupEnabled) return res.json([]);
  try {
    const u = ORDER_APP_URL + "/api/pricing/search?q=" + encodeURIComponent(req.query.q || "");
    const r = await fetch(u, { headers: { "x-api-key": PRICING_API_KEY } });
    res.json(r.ok ? await r.json() : []);
  } catch (e) { console.error("order/search", e.message); res.json([]); }
});

app.get("/api/order/lookup/:orderNumber", async (req, res) => {
  if (!lookupEnabled) return res.status(503).json({ error: "lookup disabled" });
  try {
    const u = ORDER_APP_URL + "/api/pricing/lookup/" + encodeURIComponent(req.params.orderNumber);
    const r = await fetch(u, { headers: { "x-api-key": PRICING_API_KEY } });
    if (!r.ok) return res.status(r.status).json({ error: "order not found" });
    res.json(await r.json());
  } catch (e) { console.error("order/lookup", e.message); res.status(502).json({ error: "order app unreachable" }); }
});

const PORT = process.env.PORT || 3000;
initDb()
  .catch((e) => console.error("DB init error:", e))
  .finally(() => app.listen(PORT, () => console.log("Listening on " + PORT)));
