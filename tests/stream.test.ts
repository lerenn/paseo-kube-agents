import { PassThrough } from "node:stream";
import { describe, expect, it } from "vitest";
import { ndjsonStream } from "../server/kube.js";

describe("ndjsonStream", () => {
  it("frames messages across chunks and skips non-JSON lines", async () => {
    const stdout = new PassThrough();
    const stdin = new PassThrough();
    const stream = ndjsonStream({ stdin, stdout, kill: () => true } as any);
    stdout.write('{"jsonrpc":"2.0","method":"a"}\nnot json\n{"jsonrpc":"2.0",');
    stdout.write('"method":"b"}\n');
    stdout.end();
    const got: unknown[] = [];
    for await (const m of stream.readable as any) got.push(m);
    expect(got).toEqual([{ jsonrpc: "2.0", method: "a" }, { jsonrpc: "2.0", method: "b" }]);

    const w = stream.writable.getWriter();
    await w.write({ jsonrpc: "2.0", method: "x" });
    expect(stdin.read().toString()).toBe('{"jsonrpc":"2.0","method":"x"}\n');
  });
});
