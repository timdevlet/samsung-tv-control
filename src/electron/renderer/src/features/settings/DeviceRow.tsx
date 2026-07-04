import type { STDevice } from "../../types";
import { ToggleSwitch } from "../../components/ToggleSwitch";

// One TV row: label + subtitle, switch on the right. Clicking the label toggles the switch.
export function DeviceRow({
  device,
  checked,
  onChange,
}: {
  device: STDevice;
  checked: boolean;
  onChange: (checked: boolean) => void;
}) {
  // Subtitle: the model name (when it differs from the label) and the device id, so the opaque
  // SmartThings UUID stays visible for debugging/support.
  const subtitle = [device.name && device.name !== device.label ? device.name : null, device.deviceId]
    .filter(Boolean)
    .join(" · ");
  const inputId = `dev-${device.deviceId}`;
  return (
    <div className="device-row">
      <label htmlFor={inputId}>
        {device.label}
        <small>{subtitle}</small>
      </label>
      <ToggleSwitch id={inputId} checked={checked} onChange={onChange} />
    </div>
  );
}
