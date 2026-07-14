import fs from "fs";
import path from "path";

const threshold = Number(process.env.COVERAGE_THRESHOLD || 80);
const summaryPath = path.join(process.cwd(), "coverage", "coverage-summary.json");

if (!fs.existsSync(summaryPath)) {
  if (process.env.ALLOW_MISSING_COVERAGE === "true") {
    console.warn(`[coverage] ${summaryPath} not found; skipping because ALLOW_MISSING_COVERAGE=true`);
    process.exit(0);
  }
  console.error(`[coverage] ${summaryPath} not found. Generate coverage before running this gate.`);
  process.exit(1);
}

const summary = JSON.parse(fs.readFileSync(summaryPath, "utf-8"));
const total = summary.total || {};
const checks = ["lines", "statements", "functions", "branches"];
const failures = checks.filter((name) => Number(total[name]?.pct || 0) < threshold);

if (failures.length > 0) {
  for (const name of failures) {
    console.error(`[coverage] ${name}: ${total[name]?.pct || 0}% < ${threshold}%`);
  }
  process.exit(1);
}

console.log(`[coverage] all coverage metrics meet ${threshold}% threshold`);