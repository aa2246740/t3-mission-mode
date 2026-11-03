import fs from "node:fs";
import { spawnSync } from "node:child_process";
for (const label of JSON.parse(fs.readFileSync(".github/labels.json", "utf8"))) {
  const result = spawnSync(
    "gh",
    [
      "label",
      "create",
      label.name,
      "--repo",
      "aa2246740/t3-mission-mode",
      "--color",
      label.color,
      "--description",
      label.description,
      "--force",
    ],
    { stdio: "inherit", timeout: 30000 },
  );
  if (result.error) throw result.error;
  if (result.status !== 0) process.exit(result.status ?? 1);
}
