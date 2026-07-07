import type { DeviceListState } from "../../hooks/useDeviceList";
import type { DeviceConfigSettings } from "../../types";
import { MutedMessage } from "../../components/MutedMessage";
import { DeviceRow } from "./DeviceRow";
import "./DeviceList.scss";

export function DeviceList({
  state,
  selectedIds,
  deviceConfigs,
  onToggle,
}: {
  state: DeviceListState;
  selectedIds: ReadonlySet<string>;
  // Per-TV settings draft — rows show the user's alias/description over the SmartThings label.
  deviceConfigs: Record<string, DeviceConfigSettings>;
  onToggle: (deviceId: string, checked: boolean) => void;
}) {
  return (
    <div className="device-list">
      {state.kind === "loading" && <MutedMessage>Loading your TVs…</MutedMessage>}
      {state.kind === "message" && <MutedMessage>{state.text}</MutedMessage>}
      {state.kind === "ready" &&
        state.devices.map((device) => (
          <DeviceRow
            key={device.deviceId}
            device={device}
            alias={deviceConfigs[device.deviceId]?.alias ?? ""}
            description={deviceConfigs[device.deviceId]?.description ?? ""}
            checked={selectedIds.has(device.deviceId)}
            onChange={(checked) => onToggle(device.deviceId, checked)}
          />
        ))}
    </div>
  );
}
