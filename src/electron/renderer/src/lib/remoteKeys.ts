import type { GroupSelectGroup } from "../components/GroupSelect";

// Popular Samsung Tizen remote keys, grouped for the key-sequence picker. Values are the bare
// friendly tokens the sequence field uses ("UP", "SOURCE"); normalizeRemoteKey on the node side
// (src/api/local-tv.ts) turns each into its KEY_* id at send time.
//
// No direct "HDMI2"/"PC" jump key: on newer Tizen models the discrete KEY_HDMI1..4 keys are no-ops
// over the remote WebSocket, so a single-key preset can't reliably land on the PC input. The
// working path is "Source" (opens the input panel) + Navigation arrows + Enter, recorded as a key
// sequence tuned to that TV's source-list layout — which is exactly what this grouped picker builds.
export const REMOTE_KEY_GROUPS: readonly GroupSelectGroup[] = [
  {
    label: "Navigation",
    options: [
      { value: "UP", label: "Up" },
      { value: "DOWN", label: "Down" },
      { value: "LEFT", label: "Left" },
      { value: "RIGHT", label: "Right" },
      { value: "ENTER", label: "Enter / OK" },
      { value: "RETURN", label: "Back" },
      { value: "EXIT", label: "Exit" },
    ],
  },
  {
    label: "Sources",
    options: [
      { value: "SOURCE", label: "Source" },
      { value: "HOME", label: "Home" },
      { value: "MENU", label: "Menu" },
    ],
  },
  {
    label: "Power",
    options: [
      { value: "Power", label: "Power" },
      { value: "PowerOFF", label: "OFF if ON" },
      { value: "PowerON", label: "ON if OFF" },
    ],
  },
  {
    label: "Volume",
    options: [
      { value: "VOLUP", label: "Volume up" },
      { value: "VOLDOWN", label: "Volume down" },
      { value: "MUTE", label: "Mute" },
    ],
  },
  {
    label: "Channel",
    options: [
      { value: "CHUP", label: "Channel up" },
      { value: "CHDOWN", label: "Channel down" },
      { value: "CH_LIST", label: "Channel list" },
    ],
  },
  {
    label: "Numbers",
    options: Array.from({ length: 10 }, (_, i) => ({ value: String(i), label: String(i) })),
  },
  {
    label: "Playback",
    options: [
      { value: "PLAY", label: "Play" },
      { value: "PAUSE", label: "Pause" },
      { value: "STOP", label: "Stop" },
    ],
  },
  {
    label: "More",
    options: [
      { value: "INFO", label: "Info" },
      { value: "GUIDE", label: "Guide" },
      { value: "TOOLS", label: "Tools" },
    ],
  },
];

// Append a key token to a comma-separated sequence: "" → "DOWN"; "HDMI, UP" → "HDMI, UP, DOWN".
// A trailing comma the user left behind is absorbed rather than doubled.
export function appendKeyToken(seq: string, token: string): string {
  const cur = seq.trim().replace(/,\s*$/, "");
  return cur ? `${cur}, ${token}` : token;
}
