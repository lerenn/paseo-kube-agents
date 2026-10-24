import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { mkdtempSync, writeFileSync } from "node:fs";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { GH_SHIM_SCRIPT } from "../server/pod-assets.js";

async function runShim(answer: object, pathEnv = process.env.PATH ?? "") {
  const server = createServer((_req, res) => {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify(answer));
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const file = join(mkdtempSync(join(tmpdir(), "ghshim-")), "gh");
  writeFileSync(file, GH_SHIM_SCRIPT);
  const child = spawn(process.execPath, [file, "api", "/x"], {
    env: { PATH: pathEnv, PASEO_GITHUB_PROXY_URL: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, PASEO_GITHUB_PROXY_CAPABILITY: "c" },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let err = "";
  child.stderr.on("data", (d) => (err += d));
  await new Promise((r) => setTimeout(r, 200)); // stdout is not read yet: the pipe fills while the shim is still writing
  const out: Buffer[] = [];
  child.stdout.on("data", (d) => out.push(d));
  child.stdout.resume();
  const code = await new Promise<number | null>((r) => (child.exitCode !== null ? r(child.exitCode) : child.on("exit", r)));
  await new Promise((r) => setTimeout(r, 100));
  server.close();
  return { code, out: Buffer.concat(out).toString(), err };
}

describe("gh shim in the pod", () => {
  it("prints a response far larger than a pipe buffer in full", async () => {
    const big = "x".repeat(500_000);
    const r = await runShim({ stdout: big, stderr: "", code: 0 });
    expect(r.code).toBe(0);
    expect(r.out.length).toBe(big.length);
  });

  it("says so when --jq cannot run, instead of printing unfiltered output", async () => {
    const r = await runShim({ stdout: '{"a":1}', stderr: "", code: 0, jq: ".a" }, "/nonexistent");
    expect(r.code).toBe(1);
    expect(r.err).toMatch(/--jq needs the jq command/);
  });
});
