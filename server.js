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
const fs = require("fs");
const { Pool } = require("pg");
const catalog = require("./catalog");

const app = express();
app.use(express.json({ limit: "1mb" }));

// ---- Per-supplier page: inject ONLY this deployment's supplier catalogue into the HTML ----
// SUPPLIER env picks which one (default "southern"). The browser therefore never receives
// another supplier's prices — true separation, no login needed.
const SUPPLIER = (process.env.SUPPLIER || "southern").toLowerCase();
const INDEX_PATH = path.join(__dirname, "public", "index.html");
let RENDERED_INDEX = null;
function getIndexHtml() {
  if (RENDERED_INDEX) return RENDERED_INDEX;
  const cat = catalog[SUPPLIER] || catalog.southern;
  const raw = fs.readFileSync(INDEX_PATH, "utf8");
  const json = JSON.stringify(cat).replace(/</g, "\\u003c"); // guard against </script>
  const inject = "<script>window.__CATALOG__=" + json + ";</script>\n";
  // inject before the FIRST <script> (the app script) — robust to line endings
  if (raw.indexOf("<script>") === -1) throw new Error("index.html has no <script> to inject before");
  RENDERED_INDEX = raw.replace("<script>", inject + "<script>");
  console.log("Serving catalogue for supplier: " + (cat && cat.key) + " (" + ((cat && cat.skus) || []).length + " SKUs)");
  return RENDERED_INDEX;
}
app.get(["/", "/index.html"], function (_req, res) {
  res.setHeader("Cache-Control", "no-cache, no-store, must-revalidate");
  res.type("html").send(getIndexHtml());
});

// static assets only (index.html is served above with the catalogue injected)
app.use(express.static(path.join(__dirname, "public"), {
  index: false,
  setHeaders: function (res, filePath) {
    if (filePath.endsWith(".html")) {
      res.setHeader("Cache-Control", "no-cache, no-store, must-revalidate");
    }
  }
}));

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
  await pool.query(`ALTER TABLE orders ADD COLUMN IF NOT EXISTS supplier TEXT`);
  await pool.query(`ALTER TABLE orders ADD COLUMN IF NOT EXISTS invoice TEXT`);
  await pool.query(`ALTER TABLE orders ADD COLUMN IF NOT EXISTS invoice_total NUMERIC`);
  await pool.query(`ALTER TABLE orders ADD COLUMN IF NOT EXISTS box_qty NUMERIC`);
  // Backfill legacy rows (saved before per-supplier tagging): Comfi/Imperial = Mattressshire, else Southern.
  await pool.query(`UPDATE orders SET supplier = 'mattressshire' WHERE supplier IS NULL AND (model ILIKE '%comfi%' OR model ILIKE '%imperial%')`);
  await pool.query(`UPDATE orders SET supplier = 'southern' WHERE supplier IS NULL`);
  console.log("Database ready. This deployment's supplier: " + SUPPLIER);
}

// health: the front-end pings this to decide DB vs local-storage mode
app.get("/api/health", async (_req, res) => {
  if (!pool) return res.status(503).json({ ok: false });
  try { await pool.query("SELECT 1"); res.json({ ok: true }); }
  catch (e) { res.status(503).json({ ok: false }); }
});

// list — newest first, scoped to THIS deployment's supplier ("combined" sees all)
app.get("/api/orders", async (_req, res) => {
  if (!pool) return res.status(503).json([]);
  try {
    let where = "", params = [];
    if (SUPPLIER !== "combined") { where = "WHERE supplier = $1"; params = [SUPPLIER]; }
    const { rows } = await pool.query(
      `SELECT id, order_no AS "order", created_at AS ts, model, size, depth, calc, agreed, carriage, lines, diagram, supplier, invoice, invoice_total AS "invoiceTotal", box_qty AS "boxQty"
         FROM orders ${where} ORDER BY created_at DESC LIMIT 2000`, params
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
      `INSERT INTO orders (order_no, model, size, depth, calc, agreed, carriage, lines, diagram, supplier, invoice, invoice_total, box_qty)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13) RETURNING id`,
      [b.order, b.model || null, b.size || null, b.depth || null,
       b.calc == null ? null : b.calc, b.agreed == null ? null : b.agreed,
       b.carriage || null, JSON.stringify(b.lines || []), b.diagram || null,
       SUPPLIER,  // tag with THIS deployment's supplier so each calculator lists only its own
       b.invoice || null,
       (b.invoiceTotal == null || b.invoiceTotal === "") ? null : b.invoiceTotal,
       (b.boxQty == null || b.boxQty === "") ? null : b.boxQty]
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
