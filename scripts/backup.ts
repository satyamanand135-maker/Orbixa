import dotenv from "dotenv";
import fs from "fs/promises";
import path from "path";
import mongoose from "mongoose";
import { Document, Connector, VectorDb, User, Organization, AuditLog, WebhookLog } from "../server-db.ts";

dotenv.config();

const collections = { Document, Connector, VectorDb, User, Organization, AuditLog, WebhookLog };
const mongoUri = process.env.MONGODB_URI || "mongodb://localhost:27017/dhub";
const backupDir = process.env.BACKUP_DIR || path.join(process.cwd(), "backups");
const timestamp = new Date().toISOString().replace(/[:.]/g, "-");

await mongoose.connect(mongoUri);
await fs.mkdir(backupDir, { recursive: true });

for (const [name, model] of Object.entries(collections)) {
  const rows = await (model as any).find({}).lean();
  const file = path.join(backupDir, `${timestamp}-${name}.json`);
  await fs.writeFile(file, JSON.stringify(rows, null, 2));
  console.log(`[backup] ${name}: ${rows.length} row(s) -> ${file}`);
}

await mongoose.disconnect();