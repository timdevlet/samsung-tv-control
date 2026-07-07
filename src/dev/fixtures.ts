// Mock SmartThings payloads for dev mode (src/dev/mock-cloud.ts) and tests. Typed as the raw
// wire shapes from src/domain/tv.ts so `tsc` catches drift between the fake and the real parser.

import type { RawDevice, RawStatus, InputSource } from "../domain/tv.js";

// The source list a mock TV reports once it's on. Includes the HDMI2/"PC" entry the default
// config targets, plus a couple of extras so the Settings input list looks like a real TV's.
export const MOCK_SOURCES: InputSource[] = [
  { id: "dtv", name: "TV" },
  { id: "HDMI1", name: "AV Receiver" },
  { id: "HDMI2", name: "PC" },
];

// Two TVs so dev mode exercises multi-TV selection and BOTH input capabilities
// (INPUT_CAPABILITIES in src/domain/tv.ts).
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
