import { describe, expect, it } from "vitest";
import { buildReceivePackRejectResponse, parseReceivePackResult } from "./git-protocol.js";

function pkt(s: string | Buffer): Buffer {
  const buf = typeof s === "string" ? Buffer.from(s, "utf8") : s;
  return Buffer.concat([Buffer.from((buf.length + 4).toString(16).padStart(4, "0"), "ascii"), buf]);
}

describe("parseReceivePackResult", () => {
  it("parses plain report-status ok and ng ref updates", () => {
    const raw = Buffer.concat([
      pkt("unpack ok\n"),
      pkt("ok refs/heads/agent/good\n"),
      pkt("ng refs/heads/agent/bad non-fast-forward\n"),
      Buffer.from("0000", "ascii"),
    ]);

    const res = parseReceivePackResult(new Uint8Array(raw));
    expect(res.unpackOk).toBe(true);
    expect(res.refs.get("refs/heads/agent/good")).toEqual({ ok: true, message: "" });
    expect(res.refs.get("refs/heads/agent/bad")).toEqual({
      ok: false,
      message: "non-fast-forward",
    });
  });

  it("parses side-band-64k wrapped report-status responses", () => {
    const rejectBuf = buildReceivePackRejectResponse(
      [{ oldSha: "0".repeat(40), newSha: "a".repeat(40), ref: "refs/heads/main" }],
      "protected branch",
      new Set(["side-band-64k"]),
    );

    const res = parseReceivePackResult(new Uint8Array(rejectBuf));
    expect(res.unpackOk).toBe(true);
    expect(res.refs.get("refs/heads/main")).toEqual({
      ok: false,
      message: "protected branch",
    });
  });

  it("marks unpackOk=false when unpack fails", () => {
    const raw = Buffer.concat([
      pkt("unpack index-pack failed\n"),
      pkt("ng refs/heads/agent/x unpacker error\n"),
      Buffer.from("0000", "ascii"),
    ]);

    const res = parseReceivePackResult(new Uint8Array(raw));
    expect(res.unpackOk).toBe(false);
    expect(res.refs.get("refs/heads/agent/x")?.ok).toBe(false);
  });
});
