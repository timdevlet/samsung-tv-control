// The transport seam: the set of TV operations the app (src/app.ts) needs, independent of HOW
// the TV is reached. Two implementations conform to it — SmartThings (cloud REST, src/api/
// smartthings.ts) and LocalTV (LAN: Wake-on-LAN + the Samsung remote WebSocket, src/api/
// local-tv.ts). app.ts's RoutingTransport runs both side by side, dispatching per deviceId (a
// `local:<mac>` id → LAN, a SmartThings UUID → cloud) and merging their device lists.
// This file is an I/O contract, so it lives under api/ (not the pure domain/tv.ts) and only
// imports the pure domain types.

import type { STDevice, TVStatus } from "../domain/tv.js";

export interface TVTransport {
  // Read power state, the input capability in use, current input, and the source list. A LAN
  // transport can only report power coarsely (reachable = on) and usually can't read the current
  // input — it returns a synthetic inputCapability so app.ts's switch flow still proceeds.
  getStatus(deviceId: string): Promise<TVStatus>;
  powerOn(deviceId: string): Promise<void>;
  powerOff(deviceId: string): Promise<void>;
  // Switch the input. `capability` is the id from getStatus().inputCapability (the LAN transport
  // uses a sentinel it recognizes); `source` is the resolved input id (e.g. "HDMI2").
  setInputSource(deviceId: string, capability: string, source: string): Promise<void>;
  // All devices on the "account" (cloud) or configured locally (LAN), for the device list.
  // Callers derive the TV subset with domain/tv.ts's isTV/pickTV — filtering is not a per-
  // transport concern, so the interface stays one method per actual I/O shape.
  listDevices(): Promise<STDevice[]>;
}
