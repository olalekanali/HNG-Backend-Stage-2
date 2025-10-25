import express from "express";
import helmet from "helmet";
import axios from "axios";
import dotenv from "dotenv";
import fs from "fs";
import path from "path";
import { createCanvas } from "canvas";
import database from "./src/config/db/connectDb.js"; // assume mysql2/promise pool

dotenv.config();

const app = express();
const PORT = process.env.PORT || 4000;
const CACHE_DIR = "./cache";
const SUMMARY_IMAGE = path.join(CACHE_DIR, "summary.png");

// Middleware
app.use(helmet());
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// Ensure columns allow NULL (optional safe migration attempt)
(async () => {
  try {
    await database.query(`
      ALTER TABLE countries
      MODIFY currency_code VARCHAR(10) NULL,
      MODIFY exchange_rate DECIMAL(20,6) NULL,
      MODIFY estimated_gdp DOUBLE NULL;
    `);
  } catch (err) {
    // best-effort: ignore common errors (table/field missing)
    console.warn("Migration attempt (non-fatal):", err.message);
  }
})();

// Root
app.get("/", (req, res) => res.json({ message: "Welcome to the Country REST API 🚀" }));

/**
 * POST /countries/refresh
 * - Fetch countries from restcountries (v2 as requested)
 * - Fetch exchange rates from open.er-api.com
 * - If any external fetch fails -> 503 and DO NOT modify DB
 * - Otherwise insert/update each country in a transaction
 * - For countries with no currency -> currency_code=null, exchange_rate=null, estimated_gdp=0
 * - For currency not present in rates -> exchange_rate=null, estimated_gdp=null
 * - last_refreshed_at set to CURRENT_TIMESTAMP on insert/update
 */
app.post("/countries/refresh", async (req, res, next) => {
  const countriesUrl =
    "https://restcountries.com/v2/all?fields=name,capital,region,population,flag,currencies";
  const exchangeUrl = "https://open.er-api.com/v6/latest/USD";

  let countriesData;
  let exchangeData;

  try {
    // fetch both external APIs (10s timeout)
    const [countriesResp, exchangeResp] = await Promise.all([
      axios.get(countriesUrl, { timeout: 10000 }),
      axios.get(exchangeUrl, { timeout: 10000 }),
    ]);
    countriesData = countriesResp.data;
    exchangeData = exchangeResp.data;
    if (!Array.isArray(countriesData)) throw new Error("Invalid countries data");
    if (!exchangeData || exchangeData.result !== "success" || !exchangeData.rates)
      throw new Error("Invalid exchange data");
  } catch (err) {
    console.error("External fetch failed:", err.message);
    return res.status(503).json({
      error: "External data source unavailable",
      details: err.message.includes("countries")
        ? "Could not fetch data from RestCountries API"
        : "Could not fetch data from Exchange Rates API",
    });
  }

  // map rates object for quick lookup
  const rates = exchangeData.rates; // { "NGN": 1600.23, ... }

  // Use a connection for transaction-based update
  let conn;
  try {
    conn = await database.getConnection();
    await conn.beginTransaction();

    // Loop through countries and insert/update
    let processed = 0;
    for (const c of countriesData) {
      // extract fields
      const name = (c.name && c.name) || null; // restcountries v2 returns name as string
      const capital = Array.isArray(c.capital) ? c.capital[0] : c.capital || null;
      const region = c.region || null;
      const population = Number(c.population) || 0;

      // currencies in v2 -> array of objects [{ code: "NGN", name, symbol }, ...]
      let currency_code = null;
      if (Array.isArray(c.currencies) && c.currencies.length > 0) {
        currency_code = c.currencies[0].code || null;
      }

      let exchange_rate = null;
      let estimated_gdp = null;

      if (!currency_code) {
        // spec: currencies array empty => store record, exchange_rate null, estimated_gdp 0
        exchange_rate = null;
        estimated_gdp = 0;
      } else {
        // currency_code present: look up in rates
        const rate = rates[currency_code];
        if (rate === undefined) {
          // rate not found
          exchange_rate = null;
          estimated_gdp = null;
        } else {
          exchange_rate = Number(rate);
          // random multiplier between 1000 and 2000 (inclusive). Use integer for clarity.
          const multiplier = Math.floor(Math.random() * (2000 - 1000 + 1)) + 1000;
          // estimated_gdp = population × multiplier ÷ exchange_rate
          // handle divide by zero defensively
          estimated_gdp =
            exchange_rate === 0 ? null : (population * multiplier) / exchange_rate;
        }
      }

      // Insert or update (assumes countries.name has UNIQUE constraint)
      // Use parameterized query to avoid injection
      const sql = `
        INSERT INTO countries
          (name, capital, region, population, currency_code, exchange_rate, estimated_gdp, flag_url, last_refreshed_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
        ON DUPLICATE KEY UPDATE
          capital = VALUES(capital),
          region = VALUES(region),
          population = VALUES(population),
          currency_code = VALUES(currency_code),
          exchange_rate = VALUES(exchange_rate),
          estimated_gdp = VALUES(estimated_gdp),
          flag_url = VALUES(flag_url),
          last_refreshed_at = CURRENT_TIMESTAMP
      `;
      const flag_url = c.flag || null; // restcountries v2 field
      await conn.query(sql, [
        name,
        capital,
        region,
        population,
        currency_code,
        exchange_rate,
        estimated_gdp,
        flag_url,
      ]);
      processed++;
    }

    // commit only after all writes succeeded
    await conn.commit();

    // generate summary image now that DB is updated
    await generateSummaryImage(); // will read from DB

    res.status(200).json({ message: "Countries refreshed successfully", total: processed });
  } catch (err) {
    console.error("Refresh transaction failed:", err.message);
    if (conn) await conn.rollback();
    return res.status(500).json({ error: "Internal server error" });
  } finally {
    if (conn) conn.release();
  }
});

// GET /countries with filters & sorting
app.get("/countries", async (req, res) => {
  try {
    const { region, currency, sort } = req.query;
    const params = [];
    let sql = "SELECT id, name, capital, region, population, currency_code, exchange_rate, estimated_gdp, flag_url, last_refreshed_at FROM countries WHERE 1=1";

    if (region) {
      sql += " AND region = ?";
      params.push(region);
    }
    if (currency) {
      sql += " AND currency_code = ?";
      params.push(currency);
    }

    if (sort) {
      if (sort === "gdp_desc") sql += " ORDER BY estimated_gdp DESC";
      else if (sort === "gdp_asc") sql += " ORDER BY estimated_gdp ASC";
      else if (sort === "name_asc") sql += " ORDER BY name ASC";
      else if (sort === "name_desc") sql += " ORDER BY name DESC";
    }

    const [rows] = await database.query(sql, params);
    res.json(rows);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Internal server error" });
  }
});

// GET /countries/image
app.get("/countries/image", (req, res) => {
  if (!fs.existsSync(SUMMARY_IMAGE)) {
    return res.status(404).json({ error: "Summary image not found" });
  }
  res.sendFile(path.resolve(SUMMARY_IMAGE));
});

// GET /countries/:name
app.get("/countries/:name", async (req, res) => {
  try {
    const { name } = req.params;
    if (!name || !name.trim()) {
      return res.status(400).json({ error: "Validation failed", details: { name: "is required" } });
    }
    const [rows] = await database.query(
      "SELECT id, name, capital, region, population, currency_code, exchange_rate, estimated_gdp, flag_url, last_refreshed_at FROM countries WHERE LOWER(name) = LOWER(?) LIMIT 1",
      [name]
    );
    if (!rows.length) return res.status(404).json({ error: "Country not found" });
    res.json(rows[0]);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Internal server error" });
  }
});

// DELETE /countries/:name
app.delete("/countries/:name", async (req, res) => {
  try {
    const { name } = req.params;
    if (!name || !name.trim()) {
      return res.status(400).json({ error: "Validation failed", details: { name: "is required" } });
    }
    const [result] = await database.query("DELETE FROM countries WHERE LOWER(name) = LOWER(?)", [name]);
    if (result.affectedRows === 0) return res.status(404).json({ error: "Country not found" });
    res.json({ message: `Country '${name}' deleted successfully` });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Internal server error" });
  }
});

// GET /status
app.get("/status", async (req, res) => {
  try {
    const [rows] = await database.query("SELECT COUNT(*) as total, MAX(last_refreshed_at) as last_refresh FROM countries");
    const total = rows[0]?.total ?? 0;
    const last_refresh = rows[0]?.last_refresh ? new Date(rows[0].last_refresh).toISOString() : null;
    res.json({ total_countries: total, last_refreshed_at: last_refresh });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Internal server error" });
  }
});



// global error handler (last)
app.use((err, req, res, next) => {
  console.error("Unhandled error:", err);
  res.status(500).json({ error: "Internal server error" });
});

app.listen(PORT, () => console.log(`Server running on port ${PORT}`));

/* ---------------------------
   Helper: generateSummaryImage
   - reads top 5 by estimated_gdp and total + last refresh
   - writes cache/summary.png
-----------------------------*/
async function generateSummaryImage() {
  try {
    if (!fs.existsSync(CACHE_DIR)) fs.mkdirSync(CACHE_DIR, { recursive: true });

    // top 5 by estimated_gdp (exclude NULLs)
    const [rows] = await database.query(
      "SELECT name, estimated_gdp FROM countries WHERE estimated_gdp IS NOT NULL ORDER BY estimated_gdp DESC LIMIT 5"
    );
    const [stats] = await database.query("SELECT COUNT(*) as total, MAX(last_refreshed_at) as last_refresh FROM countries");

    const canvas = createCanvas(800, 450);
    const ctx = canvas.getContext("2d");

    // background
    ctx.fillStyle = "#0F172A"; // dark
    ctx.fillRect(0, 0, 800, 450);

    // Title
    ctx.fillStyle = "#00FFD1";
    ctx.font = "bold 26px Sans-serif";
    ctx.fillText("🌍 Country Summary", 300, 50);

    // Stats
    ctx.fillStyle = "#FFFFFF";
    ctx.font = "16px Sans-serif";
    ctx.fillText(`Total countries: ${stats[0].total}`, 40, 110);
    ctx.fillText(
      `Last refresh: ${stats[0].last_refresh ? new Date(stats[0].last_refresh).toISOString() : "N/A"}`,
      40,
      140
    );

    // Top 5
    ctx.fillText("Top 5 by Estimated GDP:", 40, 190);
    rows.forEach((r, i) => {
      const gdpStr = Number(r.estimated_gdp).toLocaleString(undefined, { maximumFractionDigits: 2 });
      ctx.fillText(`${i + 1}. ${r.name} — ${gdpStr}`, 60, 220 + i * 30);
    });

    const buffer = canvas.toBuffer("image/png");
    fs.writeFileSync(SUMMARY_IMAGE, buffer);
    console.log("Summary image created:", SUMMARY_IMAGE);
  } catch (err) {
    console.error("Failed to generate summary image:", err.message);
  }
}
