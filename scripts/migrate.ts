import dotenv from "dotenv";
import fs from "fs/promises";
import path from "path";
import mongoose from "mongoose";

dotenv.config();

const MigrationSchema = new mongoose.Schema({
  name: { type: String, required: true, unique: true },
  appliedAt: { type: Date, default: Date.now },
});
const Migration = mongoose.model("Migration", MigrationSchema);
const mongoUri = process.env.MONGODB_URI || "mongodb://localhost:27017/dhub";
const migrationsDir = path.join(process.cwd(), "migrations");

await mongoose.connect(mongoUri);
await fs.mkdir(migrationsDir, { recursive: true });

const files = (await fs.readdir(migrationsDir)).filter((file) => file.endsWith(".js") || file.endsWith(".ts")).sort();
for (const file of files) {
  const existing = await Migration.findOne({ name: file });
  if (existing) {
    console.log(`[migration] skip ${file}`);
    continue;
  }

  const modulePath = path.join(migrationsDir, file).replace(/\\/g, "/");
  const migration = await import(`file:///${modulePath}`);
  if (typeof migration.up !== "function") throw new Error(`${file} must export async function up(mongoose)`);
  await migration.up(mongoose);
  await Migration.create({ name: file });
  console.log(`[migration] applied ${file}`);
}

await mongoose.disconnect();