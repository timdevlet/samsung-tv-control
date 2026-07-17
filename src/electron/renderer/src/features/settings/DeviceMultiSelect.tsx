import type { DeviceListState } from "../../hooks/useDeviceList";
import type { DeviceConfigSettings } from "../../types";
import { MultiSelectList } from "../../components/MultiSelectList";
import { MutedMessage } from "../../components/MutedMessage";
import { deviceMultiSelectOptions } from "./deviceOptions";

// The "TVs to control" picker: an always-visible list rendered straight into the All TVs tab (no
// dropdown trigger), each row toggled on/off by a macOS switch on its right. Each option keeps the
// row's identity — the user's alias over the
// SmartThings label, a "Cloud" badge for account TVs, and a muted subtitle (note · label/model ·
// id) — rendered by the shared deviceMultiSelectOptions so this and the Commands target selector
// look identical. Loading / not-signed-in / empty states render as a muted message in place of the
// list.
export function DeviceMultiSelect({
  state,
  selectedIds,
  deviceConfigs,
  onToggle,
}: {
  state: DeviceListState;
  selectedIds: ReadonlySet<string>;
  // Per-TV settings draft — options show the user's alias/description over the SmartThings label.
  deviceConfigs: Record<string, DeviceConfigSettings>;
  onToggle: (deviceId: string, checked: boolean) => void;
}) {
  if (state.kind === "loading") return <MutedMessage>Loading your TVs…</MutedMessage>;
  if (state.kind === "message") return <MutedMessage>{state.text}</MutedMessage>;

  const options = deviceMultiSelectOptions(state.devices, deviceConfigs);

  return (
    <MultiSelectList
      control="toggle"
      options={options}
      selected={selectedIds}
      onChange={onToggle}
    />
  );
}
