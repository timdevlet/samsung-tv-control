import type { STDevice } from "../../types";
import { ToggleSwitch } from "../../components/ToggleSwitch";

// One TV row: title + subtitle, switch on the right. Clicking the label toggles the switch.
export function DeviceRow({
  device,
  alias,
  description,
  checked,
  onChange,
}: {
  device: STDevice;
  // User-defined name shown instead of the SmartThings label ("" = none).
  alias: string;
  // User-defined note shown in the subtitle ("" = none).
  description: string;
  checked: boolean;
  onChange: (checked: boolean) => void;
}) {
  const title = alias || device.label;
  // Cloud TVs come from the SmartThings account (device.source === "cloud"); LAN-paired TVs get no
  // badge. Marked so the two kinds are distinguishable in the selection list.
  const isCloud = device.source === "cloud";
  // Subtitle: the user's description, the SmartThings label when an alias hides it (else the
  // model name when it differs), and the device id — the opaque UUID stays visible for
  // debugging/support.
  const subtitle = [
    description || null,
    alias ? device.label : device.name && device.name !== device.label ? device.name : null,
    device.deviceId,
  ]
    .filter(Boolean)
    .join(" · ");
  const inputId = `dev-${device.deviceId}`;
  return (
    <div className="device-row">
      <label htmlFor={inputId}>
        <span className="device-title">
          {title}
          {isCloud && <span className="source-badge">Cloud</span>}
        </span>
        <small>{subtitle}</small>
      </label>
      <ToggleSwitch id={inputId} checked={checked} onChange={onChange} />
    </div>
  );
}
