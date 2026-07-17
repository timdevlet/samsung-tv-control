import type { MultiSelectOption } from "../../components/MultiSelect";
import type { DeviceConfigSettings } from "../../types";

// The minimal per-TV facts the rich option builder needs. Both callers can supply these: the live
// device list (STDevice carries all four) and the settings union of live + LAN-paired ids (which
// synthesizes label/name/source from what it knows).
export type DeviceOptionInput = {
  deviceId: string;
  // The SmartThings label / live name; empty for a LAN TV that never listed.
  label: string;
  name: string;
  source?: "cloud" | "local";
};

// Builds one rich MultiSelect option per TV — the single source of truth for how a TV renders in a
// picker, shared by the "TVs to control" selector and the Commands target selector so both look
// identical. The primary line is the user's alias over the live label, with a "Cloud" badge for
// SmartThings TVs; the muted subtitle is the user's note, the label an alias hides (else the model
// name when it differs), and the opaque device id (kept visible for debugging/support).
export function deviceMultiSelectOptions(
  devices: readonly DeviceOptionInput[],
  deviceConfigs: Record<string, DeviceConfigSettings>,
): MultiSelectOption[] {
  return devices.map((device) => {
    const alias = deviceConfigs[device.deviceId]?.alias?.trim() ?? "";
    const description = deviceConfigs[device.deviceId]?.description?.trim() ?? "";
    const title = alias || device.label || device.deviceId;
    const isCloud = device.source === "cloud";
    const subtitle = [
      description || null,
      alias ? device.label : device.name && device.name !== device.label ? device.name : null,
      device.deviceId,
    ]
      .filter(Boolean)
      .join(" · ");
    return {
      value: device.deviceId,
      label: (
        <>
          {title}
          {isCloud && <span className="source-badge">Cloud</span>}
        </>
      ),
      subtitle,
    };
  });
}
