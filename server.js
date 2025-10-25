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

// ✅ Ensure table allows NULL for currency_code and exchange_rate
(async () => {
  try {
    await database.query(`
      ALTER TABLE countries
      MODIFY currency_code VARCHAR(10) NULL,
      MODIFY exchange_rate DECIMAL(15,4) NULL;
    `);
  } catch (err) {
    if (err.code !== "ER_BAD_FIELD_ERROR" && err.code !== "ER_TABLE_EXISTS_ERROR") {
      console.warn("⚠️ Could not alter table:", err.message);
    }
  }
})();

// ✅ Root
app.get("/", (req, res) => res.send("Welcome to the Country REST API 🚀"));

// ✅ Refresh countries (POST /countries/refresh)
app.post("/countries/refresh", async (req, res, next) => {
  try {
    const countriesUrl =
      "https://restcountries.com/v3.1/all?fields=name,capital,region,population,flags,currencies";

    const { data } = await axios.get(countriesUrl, { timeout: 10000 });
    if (!data || !Array.isArray(data)) {
      return res.status(503).json({
        error: "External data source unavailable",
        details: "Could not fetch data from RestCountries API",
      });
    }

    const processedCountries = [];

    for (const country of data) {
      const name = country?.name?.common || "Unknown";
      const capital = Array.isArray(country.capital)
        ? country.capital[0]
        : null;
      const region = country.region || null;
      const population = country.population || 0;

      const hasCurrency =
        country.currencies && Object.keys(country.currencies).length > 0;
      const currencyCode = hasCurrency
        ? Object.keys(country.currencies)[0]
        : null;

      let exchangeRate = null;
      let estimated_gdp = 0;

      if (currencyCode) {
        // Simulated exchange rate
        exchangeRate = Math.random() * (1500 - 700) + 700;
        const multiplier = Math.random() * (2000 - 1000) + 1000;
        estimated_gdp = (population * multiplier) / exchangeRate;
      }

      const flag_url = country.flags?.svg || country.flags?.png || null;

      await database.query(
        `
        INSERT INTO countries (
          name, capital, region, population, currency_code, exchange_rate, estimated_gdp, flag_url
        )
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)
        ON DUPLICATE KEY UPDATE
          capital = VALUES(capital),
          region = VALUES(region),
          population = VALUES(population),
          currency_code = VALUES(currency_code),
          exchange_rate = VALUES(exchange_rate),
          estimated_gdp = VALUES(estimated_gdp),
          flag_url = VALUES(flag_url),
          last_refreshed_at = CURRENT_TIMESTAMP
      `,
        [
          name,
          capital,
          region,
          population,
          currencyCode,
          exchangeRate,
          estimated_gdp,
          flag_url,
        ]
      );

      processedCountries.push({ name, region, currencyCode, estimated_gdp });
    }

    // ✅ Generate summary image
    await generateSummaryImage();

    res.status(200).json({
      message: "✅ Countries refreshed successfully",
      total: processedCountries.length,
    });
  } catch (error) {
    console.error("❌ Refresh error:", error.message);
    if (error.code === "ECONNABORTED") {
      return res.status(503).json({
        error: "External data source unavailable",
        details: "Could not fetch data from RestCountries API",
      });
    }
    next(error);
  }
});

// ✅ GET /countries (filters + sorting)
app.get("/countries", async (req, res, next) => {
  try {
    const { region, currency, sort } = req.query;
    let sql = "SELECT * FROM countries WHERE 1=1";
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
    next(err);
  }
});

// ✅ GET /countries/:name
app.get("/countries/:name", async (req, res) => {
  try {
    const { name } = req.params;
    if (!name?.trim()) {
      return res.status(400).json({
        error: "Validation failed",
        details: { name: "is required" },
      });
    }

    const [rows] = await database.query(
      "SELECT * FROM countries WHERE LOWER(name) = LOWER(?) LIMIT 1",
      [name]
    );

    if (!rows.length) {
      return res.status(404).json({ error: "Country not found" });
    }

    res.json(rows[0]);
  } catch (err) {
    res.status(500).json({ error: "Internal server error" });
  }
});

// ✅ DELETE /countries/:name
app.delete("/countries/:name", async (req, res) => {
  try {
    const { name } = req.params;
    if (!name?.trim()) {
      return res.status(400).json({
        error: "Validation failed",
        details: { name: "is required" },
      });
    }

    const [result] = await database.query(
      "DELETE FROM countries WHERE LOWER(name) = LOWER(?)",
      [name]
    );

    if (result.affectedRows === 0) {
      return res.status(404).json({ error: "Country not found" });
    }

    res.json({ message: `✅ Country '${name}' deleted successfully` });
  } catch (err) {
    res.status(500).json({ error: "Internal server error" });
  }
});

// ✅ GET /status
app.get("/status", async (req, res) => {
  try {
    const [rows] = await database.query(
      "SELECT COUNT(*) as total, MAX(last_refreshed_at) as last_refresh FROM countries"
    );
    if (!rows.length)
      return res.status(404).json({ message: "No countries found" });

    res.json({
      status: "success",
      total_countries: rows[0].total,
      last_refreshed_at: rows[0].last_refresh
        ? new Date(rows[0].last_refresh).toISOString()
        : null,
    });
  } catch (err) {
    res.status(500).json({ error: "Internal server error" });
  }
});

// ✅ GET /countries/image
app.get("/countries/image", (req, res) => {
  if (!fs.existsSync(SUMMARY_IMAGE)) {
    return res.status(404).json({ error: "Summary image not found" });
  }
  res.sendFile(path.resolve(SUMMARY_IMAGE));
});

// ✅ Global Error Handler
app.use((err, req, res, next) => {
  console.error("Unhandled error:", err.message);
  res.status(500).json({ error: "Internal server error" });
});

// ✅ Start server
app.listen(PORT, () => {
  console.log(`✅ Server is running on port ${PORT}`);
});

// 🖼️ Helper: Generate summary image
async function generateSummaryImage() {
  try {
    if (!fs.existsSync(CACHE_DIR)) fs.mkdirSync(CACHE_DIR);

    const [rows] = await database.query(
      "SELECT name, estimated_gdp FROM countries ORDER BY estimated_gdp DESC LIMIT 5"
    );
    const [stats] = await database.query(
      "SELECT COUNT(*) as total, MAX(last_refreshed_at) as last_refresh FROM countries"
    );

    const canvas = createCanvas(600, 400);
    const ctx = canvas.getContext("2d");

    ctx.fillStyle = "#121212";
    ctx.fillRect(0, 0, 600, 400);

    ctx.fillStyle = "#00FFB3";
    ctx.font = "bold 22px Sans-serif";
    ctx.fillText("🌍 Country Summary", 180, 50);

    ctx.fillStyle = "#FFFFFF";
    ctx.font = "16px Sans-serif";
    ctx.fillText(`Total Countries: ${stats[0].total}`, 40, 100);
    ctx.fillText(
      `Last Refresh: ${
        stats[0].last_refresh
          ? new Date(stats[0].last_refresh).toISOString()
          : "N/A"
      }`,
      40,
      130
    );

    ctx.fillText("Top 5 by GDP:", 40, 180);
    rows.forEach((r, i) => {
      ctx.fillText(`${i + 1}. ${r.name} — ${r.estimated_gdp.toFixed(2)}`, 60, 210 + i * 25);
    });

    const buffer = canvas.toBuffer("image/png");
    fs.writeFileSync(SUMMARY_IMAGE, buffer);
    console.log("🖼️ Summary image saved at cache/summary.png");
  } catch (err) {
    console.error("❌ Failed to generate summary image:", err.message);
  }
}
