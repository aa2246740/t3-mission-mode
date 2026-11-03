import { execFileSync } from "node:child_process";
const [from, to = "HEAD"] = process.argv.slice(2);
if (!from)
  throw new Error("Usage: npm run release:notes -- <previous-tag-or-sha> [new-tag-or-sha]");
for (const ref of [from, to])
  execFileSync("git", ["rev-parse", "--verify", `${ref}^{commit}`], { stdio: "pipe" });
const history = execFileSync("git", ["log", "--format=- %s (%h)", `${from}..${to}`], {
  encoding: "utf8",
});
process.stdout.write(
  `# Changes from ${from} to ${to}\n\n${history || "No commits in this range.\n"}`,
);
