#!/usr/bin/env node
// A stand-in for `kubectl proxy`: serves the API on a free port and records each request.
import http from "node:http";
import { appendFileSync } from "node:fs";
const log = process.env.FAKE_KUBECTL_LOG;
const argv = process.argv.slice(2);
if (log) appendFileSync(log, JSON.stringify({ argv }) + "\n");
if (!argv.includes("proxy")) process.exit(2);
const server = http.createServer(async (req, res) => {
  const chunks = [];
  for await (const c of req) chunks.push(c);
  if (log) appendFileSync(log, JSON.stringify({ method: req.method, url: req.url, type: req.headers["content-type"], body: Buffer.concat(chunks).toString() }) + "\n");
  const status = Number(process.env.FAKE_KUBECTL_STATUS || 200);
  res.writeHead(status, { "content-type": "application/json" });
  res.end(JSON.stringify({ data: { CLAUDE_CODE_OAUTH_TOKEN: "c2VjcmV0LXZhbHVl" } })); // a real reply carries every value
});
server.listen(0, "127.0.0.1", () => console.log(`Starting to serve on 127.0.0.1:${server.address().port}`));
