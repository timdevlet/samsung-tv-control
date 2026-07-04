import type { DeviceListState } from "../../hooks/useDeviceList";
import { MutedMessage } from "../../components/MutedMessage";
import { DeviceRow } from "./DeviceRow";
import "./DeviceList.scss";

export function DeviceList({
  state,
  selectedIds,
  onToggle,
}: {
  state: DeviceListState;
  selectedIds: ReadonlySet<string>;
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
            checked={selectedIds.has(device.deviceId)}
            onChange={(checked) => onToggle(device.deviceId, checked)}
          />
        ))}
    </div>
  );
}
