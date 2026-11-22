import zlib from "node:zlib";
import type { ForgeType } from "@agentic-git/shared";

export interface GitPushCommand {
  oldSha: string;
  newSha: string;
  ref: string;
}

export interface ParsedReceivePack {
  commands: GitPushCommand[];
  capabilities: Set<string>;
}

/**
 * Parses the leading Git pkt-line commands & negotiated capabilities
 * from a git-receive-pack HTTP request body (supports optional gzip).
 */
export function parseReceivePack(
  rawBody: Uint8Array,
  contentEncoding?: string | null,
): ParsedReceivePack {
  const buf =
    contentEncoding?.toLowerCase().includes("gzip")
      ? zlib.gunzipSync(Buffer.from(rawBody))
      : Buffer.from(rawBody);

  const commands: GitPushCommand[] = [];
  const capabilities = new Set<string>();
  let offset = 0;

  while (offset + 4 <= buf.length) {
    const lenHex = buf.subarray(offset, offset + 4).toString("ascii");
    if (lenHex === "0000") {
      break;
    }
    const pktLen = Number.parseInt(lenHex, 16);
    if (!Number.isFinite(pktLen) || pktLen < 4 || offset + pktLen > buf.length) {
      break;
    }
    const payload = buf.subarray(offset + 4, offset + pktLen).toString("utf8");
    offset += pktLen;

    const nulIdx = payload.indexOf("\0");
    if (nulIdx >= 0) {
      const capStr = payload.slice(nulIdx + 1).trim();
      for (const cap of capStr.split(/\s+/)) {
        if (cap) capabilities.add(cap);
      }
    }
    const clean = (nulIdx >= 0 ? payload.slice(0, nulIdx) : payload).trim();
    const parts = clean.split(" ");
    if (parts.length >= 3) {
      commands.push({
        oldSha: parts[0],
        newSha: parts[1],
        ref: parts.slice(2).join(" "),
      });
    }
  }

  return { commands, capabilities };
}

export function parseReceivePackCommands(
  rawBody: Uint8Array,
  contentEncoding?: string | null,
): GitPushCommand[] {
  return parseReceivePack(rawBody, contentEncoding).commands;
}

function pktLine(content: Buffer | string): Buffer {
  const buf = typeof content === "string" ? Buffer.from(content, "utf8") : content;
  const len = (buf.length + 4).toString(16).padStart(4, "0");
  return Buffer.concat([Buffer.from(len, "ascii"), buf]);
}

/**
 * Builds a valid Git Smart-HTTP receive-pack rejection response so `git push`
 * prints our custom policy rejection reason cleanly (supports side-band-64k).
 */
export function buildReceivePackRejectResponse(
  commands: GitPushCommand[],
  reason: string,
  capabilities?: Set<string>,
): Buffer {
  const useSideBand =
    capabilities?.has("side-band-64k") || capabilities?.has("side-band") || false;

  const statusChunks: Buffer[] = [pktLine("unpack ok\n")];
  for (const cmd of commands) {
    statusChunks.push(pktLine(`ng ${cmd.ref} ${reason}\n`));
  }
  statusChunks.push(Buffer.from("0000", "ascii"));
  const innerStatus = Buffer.concat(statusChunks);

  if (!useSideBand) {
    return innerStatus;
  }

  // Band 2: human-readable remote message; Band 1: report-status payload
  const msgBand = pktLine(Buffer.concat([Buffer.from([0x02]), Buffer.from(`[agentic-git] ${reason}\n`, "utf8")]));
  const statusBand = pktLine(Buffer.concat([Buffer.from([0x01]), innerStatus]));
  return Buffer.concat([msgBand, statusBand, Buffer.from("0000", "ascii")]);
}

export interface ReceivePackRefResult {
  ok: boolean;
  message: string;
}

export interface ParsedReceivePackResult {
  unpackOk: boolean;
  refs: Map<string, ReceivePackRefResult>;
}

function readPktLines(buf: Buffer): Buffer[] {
  const packets: Buffer[] = [];
  let offset = 0;
  while (offset + 4 <= buf.length) {
    const lenHex = buf.subarray(offset, offset + 4).toString("ascii");
    if (lenHex === "0000" || lenHex === "0001" || lenHex === "0002") {
      offset += 4;
      continue;
    }
    const pktLen = Number.parseInt(lenHex, 16);
    if (!Number.isFinite(pktLen) || pktLen < 4 || offset + pktLen > buf.length) {
      break;
    }
    packets.push(buf.subarray(offset + 4, offset + pktLen));
    offset += pktLen;
  }
  return packets;
}

/**
 * Parses an upstream `git-receive-pack` Smart-HTTP response (plain report-status or side-band)
 * to determine which refs were actually accepted (`ok`) vs rejected (`ng`).
 */
export function parseReceivePackResult(rawBody: Uint8Array): ParsedReceivePackResult {
  const buf = Buffer.from(rawBody);
  const outerPackets = readPktLines(buf);

  const band1Chunks: Buffer[] = [];
  const plainLines: string[] = [];

  for (const pkt of outerPackets) {
    if (pkt.length === 0) continue;
    const band = pkt[0];
    if (band === 0x01) {
      band1Chunks.push(pkt.subarray(1));
    } else if (band === 0x02 || band === 0x03) {
      // Progress / error human text bands; ignore for status parsing
      continue;
    } else {
      plainLines.push(pkt.toString("utf8").trim());
    }
  }

  const statusLines =
    band1Chunks.length > 0
      ? readPktLines(Buffer.concat(band1Chunks)).map((p) => p.toString("utf8").trim())
      : plainLines;

  let unpackOk = true;
  const refs = new Map<string, ReceivePackRefResult>();

  for (const line of statusLines) {
    if (!line) continue;
    if (line.startsWith("unpack ")) {
      unpackOk = line === "unpack ok";
    } else if (line.startsWith("ok ")) {
      const ref = line.slice(3).trim();
      if (ref) refs.set(ref, { ok: true, message: "" });
    } else if (line.startsWith("ng ")) {
      const rest = line.slice(3).trim();
      const spaceIdx = rest.indexOf(" ");
      const ref = spaceIdx === -1 ? rest : rest.slice(0, spaceIdx);
      const message = spaceIdx === -1 ? "" : rest.slice(spaceIdx + 1).trim();
      if (ref) refs.set(ref, { ok: false, message });
    }
  }

  return { unpackOk, refs };
}

/**
 * Builds the Basic Auth header for upstream Git Smart-HTTP forwarding.
 */
export function buildUpstreamGitAuthHeader(
  forgeType: ForgeType,
  upstreamToken: string,
): string | null {
  if (!upstreamToken) return null;
  if (forgeType === "github") {
    return "Basic " + Buffer.from(`x-access-token:${upstreamToken}`).toString("base64");
  }
  if (forgeType === "gitlab") {
    return "Basic " + Buffer.from(`oauth2:${upstreamToken}`).toString("base64");
  }
  return "Basic " + Buffer.from(`git:${upstreamToken}`).toString("base64");
}
