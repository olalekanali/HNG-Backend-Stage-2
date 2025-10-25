import express from "express";
import helmet from "helmet";
import axios from "axios";
import dotenv from "dotenv";
import fs from "fs";
import path from "path";
import { createCanvas } from "canvas";
import database from "./src/config/db/connectDb.js";

dotenv.config();

const app = express();
const PORT = process.env.PORT || 4000;
const CACHE_DIR = "./cache";
const SUMMARY_IMAGE = path.join(CACHE_DIR, "summary.png");

app.use(helmet());
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// Migration helper — ignore failures quietly
(async () => {
  try {
    await database.query(`
      ALTER TABLE countries
      MODIFY currency_code VARCHAR(10) NULL,
      MODIFY exchange_rate DECIMAL(20,6) NULL,
      MODIFY estimated_gdp DOUBLE NULL;
    `);
  } catch (err) {
    console.warn("Migration non-fatal:", err.message);
  }
})();

app.get("/", (_, res) => res.json({ message: "Welcome to the Country REST API 🚀" }));

// -------------------------------------------------------------
// POST /countries/refresh
// -------------------------------------------------------------
app.post("/countries/refresh", async (req, res) => {
  const countriesUrl = "https://restcountries.com/v2/all?fields=name,capital,region,population,flag,currencies";
  const exchangeUrl = "https://open.er-api.com/v6/latest/USD";

  try {
    const [countriesResp, exchangeResp] = await Promise.all([
      axios.get(countriesUrl, { timeout: 8000 }),
      axios.get(exchangeUrl, { timeout: 8000 }),
    ]);

    const countriesData = countriesResp.data;
    const exchangeData = exchangeResp.data;

    if (!Array.isArray(countriesData)) throw new Error("Invalid countries response");
    if (!exchangeData?.rates) throw new Error("Invalid exchange data");

    const rates = exchangeData.rates;
    const conn = await database.getConnection();
    let processed = 0;

    try {
      await conn.beginTransaction();

      for (const c of countriesData) {
        const name = c.name || null;
        const capital = Array.isArray(c.capital) ? c.capital[0] : c.capital || null;
        const region = c.region || null;
        const population = Number(c.population) || 0;
        const flag_url = c.flag || null;

        let currency_code = null;
        let exchange_rate = null;
        let estimated_gdp = null;

        if (Array.isArray(c.currencies) && c.currencies.length > 0) {
          currency_code = c.currencies[0].code || null;
        }

        if (!currency_code) {
          estimated_gdp = 0;
        } else if (rates[currency_code]) {
          exchange_rate = Number(rates[currency_code]);
          const multiplier = Math.floor(Math.random() * 1001) + 1000;
          estimated_gdp = exchange_rate
            ? (population * multiplier) / exchange_rate
            : null;
        }

        await conn.query(
          `
          INSERT INTO countries (name, capital, region, population, currency_code, exchange_rate, estimated_gdp, flag_url, last_refreshed_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
          ON DUPLICATE KEY UPDATE
            capital=VALUES(capital),
            region=VALUES(region),
            population=VALUES(population),
            currency_code=VALUES(currency_code),
            exchange_rate=VALUES(exchange_rate),
            estimated_gdp=VALUES(estimated_gdp),
            flag_url=VALUES(flag_url),
            last_refreshed_at=CURRENT_TIMESTAMP
        `,
          [name, capital, region, population, currency_code, exchange_rate, estimated_gdp, flag_url]
        );

        processed++;
      }

      await conn.commit();
      conn.release();
      await generateSummaryImage();

      return res.status(200).json({
        message: "Countries refreshed successfully",
        total: processed,
      });
    } catch (txErr) {
      if (conn) await conn.rollback();
      conn.release();
      console.error("DB transaction failed:", txErr.message);
      return res.status(500).json({ error: "Database transaction failed" });
    }
  } catch (err) {
    console.error("Refresh failed:", err.message);
    return res.status(503).json({
      error: "External data source unavailable",
      details: err.message,
    });
  }
});

// -------------------------------------------------------------
// GET /countries (filters & sorting)
// -------------------------------------------------------------
app.get("/countries", async (req, res) => {
  try {
    const { region, currency, sort } = req.query;
    let sql =
      "SELECT id, name, capital, region, population, currency_code, exchange_rate, estimated_gdp, flag_url, last_refreshed_at FROM countries WHERE 1=1";
    const params = [];

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
    console.error("GET /countries error:", err.message);
    res.status(500).json({ error: "Internal server error" });
  }
});

// -------------------------------------------------------------
// GET /countries/:name
// -------------------------------------------------------------
app.get("/countries/:name", async (req, res) => {
  try {
    const { name } = req.params;
    if (!name?.trim()) {
      return res.status(400).json({ error: "Validation failed", details: { name: "is required" } });
    }

    const [rows] = await database.query(
      "SELECT * FROM countries WHERE LOWER(name)=LOWER(?) LIMIT 1",
      [name]
    );

    if (!rows.length) return res.status(404).json({ error: "Country not found" });
    res.json(rows[0]);
  } catch (err) {
    console.error("GET /countries/:name error:", err.message);
    res.status(500).json({ error: "Internal server error" });
  }
});

// -------------------------------------------------------------
// DELETE /countries/:name
// -------------------------------------------------------------
app.delete("/countries/:name", async (req, res) => {
  try {
    const { name } = req.params;
    if (!name?.trim()) {
      return res.status(400).json({ error: "Validation failed", details: { name: "is required" } });
    }

    const [result] = await database.query("DELETE FROM countries WHERE LOWER(name)=LOWER(?)", [name]);
    if (result.affectedRows === 0)
      return res.status(404).json({ error: "Country not found" });

    res.json({ message: `Country '${name}' deleted successfully` });
  } catch (err) {
    console.error("DELETE /countries/:name error:", err.message);
    res.status(500).json({ error: "Internal server error" });
  }
});

// -------------------------------------------------------------
// GET /countries/image
// -------------------------------------------------------------
app.get("/countries/image", (req, res) => {
  if (!fs.existsSync(SUMMARY_IMAGE)) {
    return res.status(404).json({ error: "Summary image not found" });
  }
  res.sendFile(path.resolve(SUMMARY_IMAGE));
});

// -------------------------------------------------------------
// GET /status
// -------------------------------------------------------------
app.get("/status", async (req, res) => {
  try {
    const [rows] = await database.query(
      "SELECT COUNT(*) as total, MAX(last_refreshed_at) as last_refresh FROM countries"
    );
    const total = rows[0]?.total ?? 0;
    const last_refresh = rows[0]?.last_refresh
      ? new Date(rows[0].last_refresh).toISOString()
      : null;

    res.json({ total_countries: total, last_refreshed_at: last_refresh });
  } catch (err) {
    console.error("GET /status error:", err.message);
    res.status(500).json({ error: "Internal server error" });
  }
});

// -------------------------------------------------------------
// Global error handler
// -------------------------------------------------------------
app.use((err, req, res, next) => {
  console.error("Unhandled error:", err);
  res.status(500).json({ error: "Internal server error" });
});

// -------------------------------------------------------------
// Start server
// -------------------------------------------------------------
app.listen(PORT, () => console.log(`✅ Server running on port ${PORT}`));

// -------------------------------------------------------------
// Helper: generate summary image
// -------------------------------------------------------------
async function generateSummaryImage() {
  try {
    if (!fs.existsSync(CACHE_DIR)) fs.mkdirSync(CACHE_DIR, { recursive: true });

    const [top5] = await database.query(
      "SELECT name, estimated_gdp FROM countries WHERE estimated_gdp IS NOT NULL ORDER BY estimated_gdp DESC LIMIT 5"
    );
    const [stats] = await database.query(
      "SELECT COUNT(*) as total, MAX(last_refreshed_at) as last_refresh FROM countries"
    );

    const canvas = createCanvas(800, 450);
    const ctx = canvas.getContext("2d");

    ctx.fillStyle = "#0F172A";
    ctx.fillRect(0, 0, 800, 450);

    ctx.fillStyle = "#00FFD1";
    ctx.font = "bold 26px Sans-serif";
    ctx.fillText("🌍 Country Summary", 280, 50);

    ctx.fillStyle = "#FFFFFF";
    ctx.font = "16px Sans-serif";
    ctx.fillText(`Total countries: ${stats[0].total}`, 50, 110);
    ctx.fillText(
      `Last refresh: ${stats[0].last_refresh ? new Date(stats[0].last_refresh).toISOString() : "N/A"}`,
      50,
      140
    );

    ctx.fillText("Top 5 by Estimated GDP:", 50, 190);
    top5.forEach((r, i) => {
      const gdpStr = Number(r.estimated_gdp).toLocaleString(undefined, { maximumFractionDigits: 2 });
      ctx.fillText(`${i + 1}. ${r.name} — ${gdpStr}`, 70, 220 + i * 30);
    });

    fs.writeFileSync(SUMMARY_IMAGE, canvas.toBuffer("image/png"));
    console.log("✅ Summary image created:", SUMMARY_IMAGE);
  } catch (err) {
    console.error("Failed to generate summary image:", err.message);
  }
}
