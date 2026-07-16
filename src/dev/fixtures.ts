// Mock SmartThings payloads for dev mode (src/dev/mock-cloud.ts) and tests. Typed as the raw
// wire shapes from src/domain/tv.ts so `tsc` catches drift between the fake and the real parser.

import { LOCAL_INPUT_CAPABILITY } from "../domain/tv.js";
import type { RawDevice, RawStatus, InputSource } from "../domain/tv.js";

// The source list a mock TV reports once it's on. Includes the HDMI2/"PC" entry the default
// config targets, plus a couple of extras so the Settings input list looks like a real TV's.
export const MOCK_SOURCES: InputSource[] = [
  { id: "dtv", name: "TV" },
  { id: "HDMI1", name: "AV Receiver" },
  { id: "HDMI2", name: "PC" },
];

// A stable id for the mock LAN-paired TV (mirrors localDeviceId() in api/local-tv.ts, keyed by the
// seeded MAC below). The `local:` prefix is what RoutingTransport / FakeTransport route on, so this
// device always lists as a local TV and stays visible when the mock account is signed out.
export const MOCK_LOCAL_MAC = "aa:bb:cc:dd:ee:ff";
export const MOCK_LOCAL_DEVICE_ID = `local:${MOCK_LOCAL_MAC}`;
export const MOCK_LOCAL_HOST = "10.0.0.42";

// Three TVs so dev mode exercises multi-TV selection, BOTH input capabilities (INPUT_CAPABILITIES
// in src/domain/tv.ts), AND the cloud/local split: two cloud (SmartThings UUID ids) + one LAN-
// paired (`local:` id). The LOCAL_INPUT_CAPABILITY marker matches what LocalTV advertises so isTV()
// treats it like an input-capable TV.
export const MOCK_DEVICES: RawDevice[] = [
  {
    deviceId: "mock-tv-1",
    label: "Living Room TV",
    name: "Samsung Q90 Series (65)",
    components: [
      { id: "main", capabilities: [{ id: "switch" }, { id: "samsungvd.mediaInputSource" }] },
    ],
  },
  {
    deviceId: "mock-tv-2",
    label: "Bedroom TV",
    name: "Samsung The Frame (55)",
    components: [
      { id: "main", capabilities: [{ id: "switch" }, { id: "mediaInputSource" }] },
    ],
  },
  {
    deviceId: MOCK_LOCAL_DEVICE_ID,
    label: "Office TV (LAN)",
    name: MOCK_LOCAL_HOST,
    components: [{ id: "main", capabilities: [{ id: "switch" }, { id: LOCAL_INPUT_CAPABILITY }] }],
  },
];

// A `/devices/{id}/status` body. Like a real TV, the input-source attributes are only present
// while the TV is on — the off-state omission is what drives the re-read-after-wake path in
// app.ts's ensurePoweredOn/switchOne.
export function statusBody(
  power: "on" | "off",
  currentInput: string,
  capability: string,
  sources: InputSource[] = MOCK_SOURCES,
): RawStatus {
  const main: Record<string, Record<string, { value?: unknown }>> = {
    switch: { switch: { value: power } },
  };
  if (power === "on") {
    main[capability] = {
      inputSource: { value: currentInput },
      supportedInputSourcesMap: { value: sources },
    };
  }
  return { components: { main } };
}
