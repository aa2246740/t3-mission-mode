import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { parse } from "acorn";
const failures = [];
const files = [
  ...new Set(
    execFileSync("git", ["ls-files", "-co", "--exclude-standard", "-z"], { encoding: "utf8" })
      .split("\0")
      .filter(Boolean),
  ),
];
for (const file of files) {
  if (!fs.existsSync(file)) continue;
  const stat = fs.lstatSync(file);
  if (stat.isSymbolicLink()) {
    failures.push(`${file}: repository files must not follow external symlinks`);
    continue;
  }
  if (stat.size > 2 * 1024 * 1024)
    failures.push(`${file}: exceeds the 2 MiB file-size limit; store large artifacts outside Git`);
}
const debt = fs.readFileSync("docs/technical-debt.md", "utf8");
const results = [];
function inspect(file) {
  const source = fs.readFileSync(file, "utf8");
  const comments = [];
  const ast = parse(source, {
    ecmaVersion: "latest",
    sourceType: "module",
    locations: true,
    onComment: comments,
  });
  for (const comment of comments) {
    for (const marker of comment.value.matchAll(/\b(TODO|FIXME|HACK)\b(?:\((DEBT-\d+)\))?/g)) {
      if (!marker[2] || !debt.includes(marker[2]))
        failures.push(
          `${file}: ${marker[1]} must reference a real DEBT-NNN entry in docs/technical-debt.md`,
        );
    }
  }
  const names = new Map();
  function visit(node, scope = "<module>", parent = null) {
    if (!node || typeof node !== "object") return;
    const isFunction = [
      "FunctionDeclaration",
      "FunctionExpression",
      "ArrowFunctionExpression",
    ].includes(node.type);
    if (isFunction) {
      const name = node.id?.name ?? parent?.id?.name ?? parent?.key?.name ?? "<callback>";
      const base = `${scope}.${name}`;
      const occurrence = (names.get(base) ?? 0) + 1;
      names.set(base, occurrence);
      const qualified = `${base}#${occurrence}`;
      let complexity = 1;
      function branches(child, root = false) {
        if (!child || typeof child !== "object") return;
        if (
          !root &&
          ["FunctionDeclaration", "FunctionExpression", "ArrowFunctionExpression"].includes(
            child.type,
          )
        )
          return;
        if (
          [
            "IfStatement",
            "ConditionalExpression",
            "ForStatement",
            "ForInStatement",
            "ForOfStatement",
            "WhileStatement",
            "DoWhileStatement",
            "CatchClause",
            "LogicalExpression",
          ].includes(child.type) ||
          (child.type === "SwitchCase" && child.test) ||
          (child.type === "AssignmentExpression" &&
            ["&&=", "||=", "??="].includes(child.operator)) ||
          child.optional === true
        )
          complexity++;
        for (const value of Object.values(child)) {
          if (Array.isArray(value)) value.forEach((item) => branches(item));
          else if (value && typeof value === "object") branches(value);
        }
      }
      branches(node, true);
      results.push({
        key: `${file}:${qualified}`,
        file,
        name: qualified,
        line: node.loc.start.line,
        complexity,
      });
      scope = qualified;
    }
    for (const [key, value] of Object.entries(node)) {
      if (key === "loc") continue;
      if (Array.isArray(value)) value.forEach((child) => visit(child, scope, node));
      else if (value && typeof value === "object") visit(value, scope, node);
    }
  }
  visit(ast);
}
for (const layer of ["kernel", "bridge", "hud", "ops", "native"]) {
  function walk(dir) {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const file = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(file);
      else if (/\.(mjs|js)$/.test(file)) inspect(file);
    }
  }
  walk(path.join("t3-mission", layer));
}
const budgetFile = "scripts/complexity-budget.json";
if (process.argv.includes("--record-initial-budget")) {
  if (fs.existsSync(budgetFile))
    throw new Error(
      "The initial complexity budget already exists. Reduce debt or review explicit budget edits; this command never raises an existing budget.",
    );
  fs.writeFileSync(
    budgetFile,
    JSON.stringify(
      {
        defaultMaximum: 20,
        debt: "DEBT-001",
        existing: Object.fromEntries(
          results.filter((row) => row.complexity > 20).map((row) => [row.key, row.complexity]),
        ),
      },
      null,
      2,
    ) + "\n",
  );
}
const budget = JSON.parse(fs.readFileSync(budgetFile, "utf8"));
for (const row of results) {
  const limit = budget.existing[row.key] ?? budget.defaultMaximum;
  if (row.complexity > limit)
    failures.push(
      `${row.file}:${row.line} ${row.name} complexity ${row.complexity} exceeds ${limit}; split the function and reduce DEBT-001`,
    );
}
fs.mkdirSync("reports", { recursive: true });
fs.writeFileSync(
  "reports/quality.json",
  JSON.stringify(
    {
      fileSizeLimitBytes: 2097152,
      checkedFiles: files.length,
      complexity: results.sort((a, b) => b.complexity - a.complexity),
      failures,
    },
    null,
    2,
  ) + "\n",
);
if (failures.length) {
  console.error(failures.join("\n"));
  process.exitCode = 1;
} else
  console.log(
    `Verified ${files.length} file sizes/debt markers and ${results.length} function complexity budgets. Metrics: reports/quality.json`,
  );
