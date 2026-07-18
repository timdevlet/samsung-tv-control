import { MutedMessage } from "../../components/MutedMessage";
import type { DeviceListState } from "../../hooks/useDeviceList";
import type { DeviceConfigSettings, STDevice } from "../../types";
import { type DeviceOptionInput, deviceMultiSelectOptions } from "./deviceOptions";
import "./TvControlList.scss";

// The single-select TV list that replaced the old segmented tab bar. Each row is one TV; clicking
// it selects that ONE TV (the parent then edits it and makes it what commands act on). A trailing
// "+ Add a TV" row starts the LAN pairing flow. Rows are rendered with the SAME rich option builder
// as the Commands target picker (alias/title + "Cloud" badge + muted note · label/model · id
// subtitle), so the whole Settings surface looks consistent.
//
// The row set is the union of every TV the live list reports (cloud / SmartThings, which carry no
// host in deviceConfigs) and every LAN-paired config entry (keyed `local:<mac>`, present even when
// the TV is temporarily unreachable) — matching the tabs it replaced. Loading / not-signed-in /
// empty states render as a muted message, still followed by the Add row so a first TV can be paired.
export function TvControlList({
  devices,
  deviceConfigs,
  selectedId,
  onSelect,
  onAddClick,
  adding,
}: {
  devices: DeviceListState;
  deviceConfigs: Record<string, DeviceConfigSettings>;
  // The currently selected TV, or null when nothing is selected (e.g. the Add flow is open).
  selectedId: string | null;
  onSelect: (deviceId: string) => void;
  onAddClick: () => void;
  // Whether the "+ Add a TV" flow is open — highlights that row instead of a TV.
  adding: boolean;
}) {
  // Union of live-listed TVs (cloud + any listed local) and LAN-paired config entries with a host,
  // deduped, live-list order first — the same derivation the tabs used.
  const listedById =
    devices.kind === "ready"
      ? new Map(devices.devices.map((d) => [d.deviceId, d] as const))
      : new Map<string, STDevice>();
  const ids: string[] = [];
  const seen = new Set<string>();
  const addId = (id: string) => {
    if (seen.has(id)) return;
    seen.add(id);
    ids.push(id);
  };
  if (devices.kind === "ready") devices.devices.forEach((d) => addId(d.deviceId));
  for (const [id, cfg] of Object.entries(deviceConfigs)) {
    if (cfg.host?.trim()) addId(id);
  }

  const optionInputs: DeviceOptionInput[] = ids.map((id) => {
    const listed = listedById.get(id);
    const host = deviceConfigs[id]?.host?.trim() ?? "";
    return {
      deviceId: id,
      label: listed?.label ?? host,
      name: listed?.name ?? "",
      source: listed?.source ?? (host ? ("local" as const) : undefined),
    };
  });
  const options = deviceMultiSelectOptions(optionInputs, deviceConfigs);

  // A message state (loading / signed out) with no LAN-paired TVs to show: surface it, but still
  // offer the Add row below so a local-only user can start pairing.
  const showMessage = options.length === 0 && devices.kind !== "ready";

  return (
    <div className="tv-control-list" role="radiogroup" aria-label="TV to control">
      {showMessage && (
        <MutedMessage>
          {devices.kind === "message" ? devices.text : "Loading your TVs…"}
        </MutedMessage>
      )}
      {options.map((o) => {
        const active = !adding && o.value === selectedId;
        return (
          <button
            key={o.value}
            type="button"
            role="radio"
            aria-checked={active}
            className={active ? "tv-row active" : "tv-row"}
            onClick={() => onSelect(o.value)}
          >
            <span className="tv-row-text">
              <span className="tv-row-label">{o.label}</span>
              {o.subtitle != null && o.subtitle !== "" && (
                <small className="tv-row-subtitle">{o.subtitle}</small>
              )}
            </span>
          </button>
        );
      })}
      <button
        type="button"
        className={adding ? "tv-row tv-row-add active" : "tv-row tv-row-add"}
        onClick={onAddClick}
      >
        <span className="tv-row-label">+ Add a TV</span>
      </button>
    </div>
  );
}
