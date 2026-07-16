// LAN discovery for the local transport: an SSDP (UDP multicast) M-SEARCH that finds Samsung
// TVs on the network so Settings can pre-fill a TV's host (and, where resolvable, its MAC)
// instead of making the user type an IP. No cloud, no account — just a multicast probe and
// whatever answers. Discovery is best-effort: a TV that doesn't answer SSDP can still be added by
// typing its host manually.

import { createSocket } from "node:dgram";
import { canonicalizeMac } from "../domain/config.js";

export interface DiscoveredTV {
  host: string; // the responder's IP
  name?: string; // a friendly name if the SSDP headers carry one
  mac?: string; // canonical MAC if we could resolve it (often absent — user fills it in)
}

const SSDP_ADDR = "239.255.255.250";
const SSDP_PORT = 1900;

// Samsung TVs answer M-SEARCH for these targets (the remote-control and DIAL/UPnP services).
const SEARCH_TARGETS = [
  "urn:samsung.com:device:RemoteControlReceiver:1",
  "urn:dial-multiscreen-org:service:dial:1",
];

function mSearch(target: string): Buffer {
  return Buffer.from(
    [
      "M-SEARCH * HTTP/1.1",
      `HOST: ${SSDP_ADDR}:${SSDP_PORT}`,
      'MAN: "ssdp:discover"',
      "MX: 2",
      `ST: ${target}`,
      "",
      "",
    ].join("\r\n"),
  );
}

// Parse an SSDP response's headers into a lowercased key→value map.
export function parseSsdpHeaders(response: string): Record<string, string> {
  const headers: Record<string, string> = {};
  for (const line of response.split(/\r?\n/).slice(1)) {
    const idx = line.indexOf(":");
    if (idx === -1) continue;
    headers[line.slice(0, idx).trim().toLowerCase()] = line.slice(idx + 1).trim();
  }
  return headers;
}

// Broadcast the M-SEARCH probes and collect responders for `timeoutMs`, deduped by host. Each
// discovered TV carries whatever name the headers expose; MAC is left for the user unless a later
// ARP step fills it (kept out of here — it's platform-specific and unreliable).
export async function discoverTVs(timeoutMs = 3000): Promise<DiscoveredTV[]> {
  return new Promise((resolve, reject) => {
    const socket = createSocket({ type: "udp4", reuseAddr: true });
    const found = new Map<string, DiscoveredTV>();

    // Settle exactly once: several failure paths can race (a send callback error per target, the
    // socket 'error' event, the collection timeout), and closing an already-closed dgram socket
    // throws — inside the timer callback that would be an uncaught exception in the main process.
    let settled = false;
    const finish = (fn: () => void) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      socket.close();
      fn();
    };

    const timer = setTimeout(() => finish(() => resolve([...found.values()])), timeoutMs);

    socket.on("error", (err) => finish(() => reject(err)));

    socket.on("message", (msg, rinfo) => {
      const text = msg.toString();
      if (!/^HTTP\/1\.1 200/i.test(text)) return; // only M-SEARCH responses
      const headers = parseSsdpHeaders(text);
      // Heuristic: keep responders that look like Samsung TVs.
      const server = (headers.server ?? "") + (headers.st ?? "") + (headers.usn ?? "");
      if (!/samsung|dial/i.test(server)) return;
      if (!found.has(rinfo.address)) {
        found.set(rinfo.address, { host: rinfo.address, name: headers["friendlyname"] || undefined });
      }
    });

    socket.bind(() => {
      for (const target of SEARCH_TARGETS) {
        const packet = mSearch(target);
        socket.send(packet, SSDP_PORT, SSDP_ADDR, (err) => {
          if (err) finish(() => reject(err));
        });
      }
    });
  });
}

// Best-effort MAC lookup from the OS ARP cache for a host we just discovered. Returns "" when it
// can't be resolved (the user then types the MAC). Reads only — no state change.
export async function lookupMac(host: string): Promise<string> {
  try {
    const { execFile } = await import("node:child_process");
    const { promisify } = await import("node:util");
    const run = promisify(execFile);
    const { stdout } = await run("arp", ["-n", host], { timeout: 2000 });
    const match = stdout.match(/([0-9a-f]{1,2}[:-]){5}[0-9a-f]{1,2}/i);
    return match ? canonicalizeMac(match[0]) : "";
  } catch {
    return "";
  }
}
