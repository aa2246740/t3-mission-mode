import fs from "node:fs";
import path from "node:path";
const root = process.cwd();
const manifest = JSON.parse(fs.readFileSync("package.json", "utf8"));
const files = [
  "AGENTS.md",
  "CONTRIBUTING.md",
  "docs/development.md",
  "docs/runbooks/operations.md",
  "docs/data-handling.md",
  "docs/technical-debt.md",
  "docs/feature-flags.md",
  "docs/api.md",
];
const failures = [];
for (const file of files) {
  const source = fs.readFileSync(file, "utf8");
  for (const match of source.matchAll(/\]\(([^)]+)\)/g)) {
    const link = match[1];
    if (/^(?:https?:|mailto:|#)/.test(link)) continue;
    const target = path.resolve(path.dirname(file), decodeURIComponent(link.split("#")[0]));
    if (!target.startsWith(root + path.sep) || !fs.existsSync(target))
      failures.push(`${file}: missing/foreign link ${link}`);
  }
  for (const match of source.matchAll(/npm run ([a-zA-Z][\w:-]*)/g)) {
    if (!Object.hasOwn(manifest.scripts, match[1]))
      failures.push(`${file}: undefined npm script ${match[1]}`);
  }
}
if (fs.readFileSync("SKILL.md", "utf8") !== fs.readFileSync("t3-mission/skill/SKILL.md", "utf8"))
  failures.push("Root and packaged SKILL.md differ; update both together.");
if (failures.length) {
  console.error(failures.join("\n"));
  process.exitCode = 1;
} else
  console.log(
    `Verified ${files.length} documents, their npm commands, local links, and identical skill copies.`,
  );
