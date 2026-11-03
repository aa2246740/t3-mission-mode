/** @typedef {import('node:http').IncomingMessage} IncomingMessage */
/** @typedef {import('node:http').ServerResponse} ServerResponse */
/** @param {string} code @param {string} message @param {number} statusCode */
function httpError(code, message, statusCode) {
  return Object.assign(new Error(message), { code, statusCode });
}

/** @param {IncomingMessage} req @param {{host: string, port: number}} bound */
export function assertTrustedRequest(req, bound) {
  const allowedHosts = new Set([
    `${bound.host}:${bound.port}`,
    `127.0.0.1:${bound.port}`,
    `localhost:${bound.port}`,
    `[::1]:${bound.port}`,
  ]);
  const host = req.headers.host;
  if (!host || !allowedHosts.has(host))
    throw httpError("UNTRUSTED_HOST", "Host does not match this HUD listener", 403);
  const origin = req.headers.origin;
  if (origin) {
    let parsed;
    try {
      parsed = new URL(origin);
    } catch {
      throw httpError("CROSS_ORIGIN_REQUEST", "Origin is invalid", 403);
    }
    if (parsed.protocol !== "http:" || parsed.host !== host || parsed.origin !== origin)
      throw httpError("CROSS_ORIGIN_REQUEST", "Origin does not match this HUD listener", 403);
  }
  if (req.headers["sec-fetch-site"] === "cross-site")
    throw httpError("CROSS_ORIGIN_REQUEST", "Cross-site requests are refused", 403);
}

/** @param {ServerResponse} res */
export function setSecurityHeaders(res) {
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("Referrer-Policy", "no-referrer");
  res.setHeader("X-Frame-Options", "DENY");
  res.setHeader(
    "Content-Security-Policy",
    "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; connect-src 'self'; img-src 'self' data:; frame-ancestors 'none'; base-uri 'none'; form-action 'self'",
  );
}

/** @param {IncomingMessage} req @param {number} [limit] @returns {Promise<Record<string, unknown>>} */
export function readBoundedJson(req, limit = 1024 * 1024) {
  return new Promise((resolve, reject) => {
    /** @type {Buffer[]} */
    const chunks = [];
    let bytes = 0;
    let refused = false;
    const declared = Number(req.headers["content-length"]);
    if (Number.isFinite(declared) && declared > limit) {
      refused = true;
      reject(httpError("BODY_TOO_LARGE", "JSON body exceeds 1 MiB", 413));
      req.resume();
      return;
    }
    req.on("data", (/** @type {Buffer} */ chunk) => {
      if (refused) return;
      bytes += chunk.length;
      if (bytes > limit) {
        refused = true;
        chunks.length = 0;
        reject(httpError("BODY_TOO_LARGE", "JSON body exceeds 1 MiB", 413));
      } else chunks.push(chunk);
    });
    req.on("end", () => {
      if (refused) return;
      try {
        const raw = Buffer.concat(chunks).toString("utf8").trim();
        /** @type {unknown} */
        const body = raw ? JSON.parse(raw) : {};
        if (!body || typeof body !== "object" || Array.isArray(body))
          throw httpError("INVALID_JSON_BODY", "JSON body must be an object", 400);
        resolve(/** @type {Record<string, unknown>} */ (body));
      } catch (error) {
        reject(
          error instanceof SyntaxError
            ? httpError("INVALID_JSON_BODY", "Invalid JSON body", 400)
            : error,
        );
      }
    });
    req.on("error", reject);
    req.on("aborted", () => reject(httpError("REQUEST_ABORTED", "Request body was aborted", 400)));
  });
}
