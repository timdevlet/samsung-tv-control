import type { GroupSelectGroup } from "../components/GroupSelect";

// Popular Samsung Tizen remote keys, grouped for the key-sequence picker. Values are the bare
// friendly tokens the sequence field uses ("UP", "HDMI2"); normalizeRemoteKey on the node side
// (src/api/local-tv.ts) turns each into its KEY_* id at send time. No "PC" entry — the bare token
// is aliased to KEY_HDMI2 there rather than becoming KEY_PC, which would surprise here.
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
    options: [{ value: "POWER", label: "Power" }],
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
