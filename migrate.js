import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import database from "./src/config/db/connectDb.js"; // your db connection file

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

async function runMigrations() {
  try {
    const migrationDir = path.join(__dirname, "migrations");
    const files = fs.readdirSync(migrationDir).sort();

    for (const file of files) {
      const sql = fs.readFileSync(path.join(migrationDir, file), "utf-8");
      console.log(`🚀 Running migration: ${file}`);
      await database.query(sql);
      console.log(`✅ Done: ${file}`);
    }

    console.log("🎉 All migrations executed successfully!");
    process.exit(0);
  } catch (error) {
    console.error("❌ Migration failed:", error);
    process.exit(1);
  }
}

runMigrations();
