import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { Readable } from 'node:stream';
import { createMissionHudServer } from '../hud/server.mjs';

export async function createHandlerHud(options) {
  const listen = http.Server.prototype.listen;
  http.Server.prototype.listen = function () {
    queueMicrotask(() => this.emit('listening'));
    return this;
  };
  let hud;
  try { hud = await createMissionHudServer({ ...options, port: 0 }); }
  finally { http.Server.prototype.listen = listen; }
  return { ...hud, post: (action, body = {}) => new Promise((resolve, reject) => {
    const req = Readable.from([Buffer.from(JSON.stringify(body))]);
    Object.assign(req, { method: 'POST', url: '/api/mission/' + action,
      headers: { host: '127.0.0.1', 'content-type': 'application/json' } });
    const res = { writeHead(status) { this.status = status; }, setHeader() {},
      end(text) { try { resolve({ status: this.status, body: JSON.parse(text) }); } catch (error) { reject(error); } } };
    hud.server.emit('request', req, res);
  }) };
}

export async function bounded(promise, timeoutMs = 4000) {
  let timer;
  try {
    return await Promise.race([promise, new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error('HUD handler fixture timed out')), timeoutMs);
    })]);
  } finally { clearTimeout(timer); }
}

export function saveContractEvidence(name, evidence) {
  if (process.env.R9_EVIDENCE_DIR) {
    fs.writeFileSync(path.join(process.env.R9_EVIDENCE_DIR, name + '.json'), JSON.stringify(evidence, null, 2) + '\n');
  }
}
