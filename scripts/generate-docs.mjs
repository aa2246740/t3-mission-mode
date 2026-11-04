import fs from "node:fs";
import { format, resolveConfig } from "prettier";
import { HUD_ROUTES } from "../t3-mission/ops/routes.mjs";
import { MISSION_TOOLS } from "../t3-mission/bridge/mcp-server.mjs";
const paths = {};
for (const [index, route] of HUD_ROUTES.entries()) {
  const isStream = route.kind === "stream";
  const contentType = isStream
    ? "text/event-stream"
    : route.path === "/metrics"
      ? "text/plain"
      : route.path.startsWith("/api/") || route.path.endsWith("z")
        ? "application/json"
        : route.path.endsWith(".js")
          ? "application/javascript"
          : route.path.endsWith(".css")
            ? "text/css"
            : "text/html";
  const operation = {
    operationId: `${route.operationId}_${index}`,
    summary: route.summary,
    description:
      route.kind === "write"
        ? "Local same-origin command. Approval, revision, Git, and dispatch-receipt gates remain authoritative. Reuse commandId only with the identical payload."
        : "Read-only observation. It does not dispatch, resume, reconcile, or modify a Mission.",
    parameters: [
      {
        in: "header",
        name: "X-Request-ID",
        schema: { type: "string", pattern: "^[A-Za-z0-9._-]{1,80}$" },
        description: "Optional correlation ID; returned as a response header.",
      },
    ],
    responses: {
      200: {
        description: isStream
          ? "SSE connection; mission_snapshot events contain a snapshot."
          : "Successful response",
        content: {
          [contentType]: {
            schema:
              contentType === "application/json"
                ? route.path === "/api/mission/state"
                  ? { $ref: "#/components/schemas/MissionSnapshot" }
                  : { type: "object", additionalProperties: true }
                : { type: "string" },
          },
        },
      },
      403: { $ref: "#/components/responses/Error" },
      500: { $ref: "#/components/responses/Error" },
    },
  };
  if (route.kind === "write") {
    operation.requestBody = {
      required: false,
      content: {
        "application/json": {
          schema: {
            type: "object",
            properties: {
              commandId: { type: "string", minLength: 1 },
              ...(route.operationId === "rejectMission" ? { feedback: { type: "string" } } : {}),
            },
            additionalProperties: true,
          },
        },
      },
    };
    for (const status of ["400", "409", "413"])
      operation.responses[status] = { $ref: "#/components/responses/Error" };
  }
  if (route.operationId === "steerSession") {
    const request = operation.requestBody;
    request.required = true;
    request.content["application/json"].schema = {
      type: "object",
      required: ["message"],
      properties: Object.fromEntries(
        ["sessionId", "runId", "featureId", "childThreadId", "message", "commandId"].map((name) => [
          name,
          { type: "string", minLength: 1 },
        ]),
      ),
      additionalProperties: true,
    };
    operation.responses[200].content["application/json"].schema = {
      type: "object",
      required: ["ok", "threadId", "message", "delivery"],
      properties: {
        ok: { const: true },
        threadId: { type: "string" },
        message: { type: "string" },
        delivery: { enum: ["sent", "recorded"] },
      },
    };
    for (const status of ["404", "502"])
      operation.responses[status] = { $ref: "#/components/responses/Error" };
  }
  if (route.path === "/readyz")
    operation.responses["503"] = { $ref: "#/components/responses/Error" };
  paths[route.path] = { [route.method.toLowerCase()]: operation };
}
const schema = {
  openapi: "3.1.0",
  info: {
    title: "T3 Mission Mode local HUD API",
    version: JSON.parse(fs.readFileSync("package.json", "utf8")).version,
  },
  servers: [
    {
      url: "http://127.0.0.1:43110",
      description: "Example loopback listener; use the actual printed URL.",
    },
  ],
  paths,
  components: {
    schemas: {
      MissionSnapshot: {
        type: "object",
        required: ["state", "features", "modelSettings", "progressLog"],
        properties: {
          state: {
            type: "object",
            properties: {
              initialized: { type: "boolean" },
              missionId: { type: "string" },
              status: { type: "string" },
              revision: { type: "integer" },
            },
            additionalProperties: true,
          },
          features: { type: "array", items: { type: "object", additionalProperties: true } },
          modelSettings: { type: "object", additionalProperties: true },
          progressLog: { type: "array", items: { type: "object", additionalProperties: true } },
        },
        additionalProperties: true,
      },
      Error: {
        type: "object",
        properties: {
          ok: { const: false },
          code: { type: "string" },
          error: { type: "string" },
          requestId: { type: "string" },
        },
        additionalProperties: true,
      },
    },
    responses: {
      Error: {
        description:
          "Request refused or runtime/storage unavailable. The request ID correlates diagnostics.",
        content: { "application/json": { schema: { $ref: "#/components/schemas/Error" } } },
      },
    },
  },
};
const reference = [
  "# HUD and Mission tool reference",
  "",
  "Generated by `npm run docs:generate` from the route catalog and the actual MCP tool schemas. Run `npm run docs:check` to detect drift.",
  "",
  "The HUD listens on loopback by default. Standalone QA needs no credentials and supplies no provider transport. Bind a Mission only in its owning T3 thread; a 200 response or a healthy HUD does not prove provider execution.",
  "",
  "Cross-origin requests and foreign Host headers are refused. Commands accept JSON objects up to 1 MiB. `X-Request-ID` is echoed for diagnostics. SSE events contain Mission snapshots; keep this listener private.",
  "",
  "| Method | Path | Behavior |",
  "| --- | --- | --- |",
  ...HUD_ROUTES.map((route) => `| ${route.method} | \`${route.path}\` | ${route.summary} |`),
  "",
  "The machine-readable contract is [openapi.json](openapi.json). Lifecycle-specific payloads still obey the kernel gates; arbitrary extra JSON properties confer no authority.",
  "",
  "## MCP lifecycle tools",
  "",
  "| Tool | Purpose |",
  "| --- | --- |",
  ...MISSION_TOOLS.map(
    (tool) =>
      `| \`${tool.name}\` | ${tool.description.replaceAll("|", "\\|").replaceAll("\n", " ")} |`,
  ),
  "",
];
const outputs = new Map([
  ["docs/openapi.json", JSON.stringify(schema, null, 2) + "\n"],
  ["docs/api.md", reference.join("\n")],
]);
let changed = false;
for (const [file, rawContent] of outputs) {
  const content = await format(rawContent, { ...(await resolveConfig(file)), filepath: file });
  if (process.argv.includes("--check")) {
    if (!fs.existsSync(file) || fs.readFileSync(file, "utf8") !== content) {
      console.error(`${file} is stale; run npm run docs:generate`);
      changed = true;
    }
  } else fs.writeFileSync(file, content);
}
if (changed) process.exitCode = 1;
else
  console.log(
    `${outputs.size} generated API documents ${process.argv.includes("--check") ? "verified" : "written"}`,
  );
