# Samsung TV → PC (SmartThings)

A small Node/TypeScript app that, in one command:

1. **Finds** your Samsung TV in your SmartThings account,
2. **Turns it on**, and
3. **Switches the input to PC** (HDMI 3 by default).

It drives the TV entirely through the **SmartThings cloud API** — no local network
access, Wake-on-LAN, or websocket pairing. This is the robust path for recent
(2024–2026) Tizen firmware, where local control and Wake-on-LAN over Wi-Fi are
unreliable. The TV's LAN IP is irrelevant here; commands are routed by SmartThings
device id.

## Prerequisites

- Node 18+ (uses built-in `fetch`). Developed on Node 26.
- The TV added to your account in the **SmartThings app** (it must show up and be
  controllable there). The TV needs to be plugged in / in networked standby so the
  cloud can wake it.
- A **SmartThings Personal Access Token (PAT)** — see below.

### Get a token

1. Go to <https://account.smartthings.com/tokens> → **Generate new token**.
2. Authorize at least the **Devices** scopes: *List all devices*, *See all devices*
   (retrieve status), and *Execute commands on all devices*.
3. Copy the token.

> ⚠️ **Token lifetime:** PATs created after **Dec 30, 2024 expire after 24 hours.**
> A PAT will work great for testing but stops working the next day; you'd generate a
> fresh one. For a permanent setup the proper fix is an OAuth flow (auto-refreshing
> tokens) — ask and I can add it.

## Setup

```sh
cd tv
npm install
```

Provide the token via env var (recommended, easy to refresh daily):

```sh
export SMARTTHINGS_TOKEN="<your-token>"
```

…or copy the template and put `"token": "<your-token>"` in it:

```sh
cp smartthings-config.example.json smartthings-config.json
```

`smartthings-config.json` is git-ignored — it holds your token/secrets and is never committed.

## Usage

```sh
npm start              # find TV → turn on → switch to the configured input
npm start -- --hdmi 3  # same, but switch to HDMI 3 this run (overrides pcInput)
npm run login          # one-time OAuth authorize (auto-refreshing token)
npm run devices        # list account devices + capabilities (to identify the TV)
npm run reset          # forget the cached device id / token
npm run electron:dev   # run the desktop tray app (global hotkeys + log window)
```

### Global hotkeys

The desktop app (`npm run electron:dev`, or a packaged build) registers two global hotkeys that
fire from anywhere — you don't need the window focused:

| Action | macOS | Windows / Linux |
| --- | --- | --- |
| Wake the TV + switch to PC | **Cmd + Ctrl + E** | **Ctrl + Alt + E** |
| Turn the TV off, then sleep this PC | **Cmd + Ctrl + Q** | **Ctrl + Alt + Q** |

Both combos are **configurable in Settings** (click the field, press your combo); an empty field
unbinds the action.

The off-and-sleep hotkey turns the TV off — but **only if it's currently on the PC input**, so
it won't switch off a TV you've put on another source — then waits 2 seconds and puts this PC to
sleep (`pmset sleepnow` on macOS, `SetSuspendState` on Windows, `systemctl suspend` on Linux).

The app also **wakes the TV automatically when this PC resumes from sleep**. It detects wake
with a simple heartbeat: a timer ticks every few seconds, and a large gap between ticks means the
process was frozen (the PC slept). On wake it turns the TV on (only if it was off) and switches to
PC, then pauses detection for 5 minutes so it can't re-fire. This works on all platforms — no
extra setup.

Hotkeys use Electron's built-in [`globalShortcut`](https://www.electronjs.org/docs/latest/api/global-shortcut)
(RegisterHotKey on Windows, a Carbon hotkey on macOS): the OS matches the combo system-wide and
calls the app directly. No native module, and the registration survives sleep/wake on its own.

> **Conflicts:** if a combo is already claimed by the OS or another app, registration fails and
> the log notes it — pick a different combo in Settings.

`--hdmi <n>` (n = 1–4) picks the input for that run without editing config; the
shorthands `--hdmi=3` and `--hdmi3` also work. Without it, `pcInput` from
`smartthings-config.json` is used.

First run finds the TV and caches its device id in `smartthings-config.json`, so
later runs skip the lookup.

## Desktop app (Electron tray + log window)

The same daemon can run as a **Windows desktop app**: it launches, drops to the **system
tray**, and opens a **window that streams the live log**. Closing the window hides it back to
the tray (the daemon keeps running); quit from the tray menu to actually exit. The tray menu
also exposes the two TV actions, and the window has **Wake TV → PC** / **TV off + sleep**
buttons so you don't need the hotkeys.

The daemon core (global hotkeys, sleep/wake auto-wake, boot reconcile) runs inside the app — the
window only mirrors the log output and adds buttons.

```sh
npm run electron:dev   # build + launch the app locally (tray + log window)
npm run dist:win       # build a Windows installer + portable .exe  → release/
npm run dist:dir       # unpacked build for quick local testing     → release/win-unpacked/
```

`npm run dist:win` produces, in `release/`:

- **`Samsung TV Control Setup <version>.exe`** — NSIS installer (creates Start-menu / desktop
  shortcuts; install dir is chooseable).
- **`Samsung TV Control <version>.exe`** — single-file **portable** exe (no install; just
  double-click).

### Where the config lives in the packaged app

The CLI/daemon read `smartthings-config.json` from the repo root, but a packaged app's files are
inside a read-only archive. So the desktop app instead reads/writes:

- **Portable exe:** `smartthings-config.json` **next to the .exe** — drop your authorized config
  file beside it, or it's created there on first save.
- **Installer:** `%APPDATA%\Samsung TV Control\smartthings-config.json`.

Either way you can override the location with the `SMARTTHINGS_CONFIG_PATH` env var, or just set
`SMARTTHINGS_TOKEN`. Authorize once with `npm run login` (in the repo) and copy the resulting
`smartthings-config.json` to the location above — there's no in-app OAuth UI yet.

### Building the Windows exe

> The app has **no native modules** (global hotkeys use Electron's built-in `globalShortcut`), so
> there's nothing to rebuild and no cross-compile caveat. Run `npm install` then `npm run dist:win`
> on a Windows machine (or Windows CI) to produce the installer + portable exe.

## Run on Windows startup

Launch the **desktop app** automatically when you log in so the global hotkeys work any time after
boot (it also auto-wakes the TV on resume and reconciles at boot). Build it once with
`npm run dist:win`, then point a startup entry at the installed/portable `Samsung TV Control.exe`.

> ⚠️ **Use OAuth for the token, not a PAT.** A startup launch runs unattended, so a 24h PAT would
> break the next day. Run `npm run login` once first — it stores an **auto-refreshing** token in
> `smartthings-config.json` that survives reboots. For a packaged app, copy that file next to the
> portable `.exe` (or to `%APPDATA%\Samsung TV Control\`); see [Where the config lives](#where-the-config-lives-in-the-packaged-app).

### Option A — Startup folder (simplest)

1. Press **Win + R**, type `shell:startup`, press Enter. This opens your per-user
   Startup folder; anything in it runs at log on.
2. Right-click `Samsung TV Control.exe` → **Send to → Desktop (create shortcut)**, then move that
   shortcut into the Startup folder. (A *shortcut* there, rather than the exe itself, keeps the
   install in place.)
3. Log out and back in to test — the app launches to the tray, registers the hotkeys, and shows
   its log window.

### Option B — Task Scheduler (more robust)

Better when you want auto-restart on failure or to run at a specific event.

1. Open **Task Scheduler** → **Create Task…** (not *Basic*).
2. **General:** name it `Samsung TV Control`; tick **Run only when user is logged on**.
3. **Triggers:** New → **Begin the task: At log on** → your user.
4. **Actions:** New → **Start a program** → **Program/script:** the full path to
   `Samsung TV Control.exe`.
5. **Settings:** optionally enable **If the task fails, restart every 1 minute**.

To switch the TV at boot *without* the persistent app, point a startup entry at `npm start`
(one-shot: wakes the TV and switches to PC, then exits) instead.

## Configuration — `smartthings-config.json`

Created/updated automatically. Editable fields:

| Field | Meaning |
| --- | --- |
| `token` | SmartThings PAT (or use `SMARTTHINGS_TOKEN`; env wins). Keep private. |
| `deviceId` | Cached SmartThings device id of the TV. |
| `deviceLabel` | TV's label (informational). |
| `pcInput` | Input the PC is on. Matched by id (`"HDMI3"`) then by label (`"PC"`). Default `"HDMI3"`. |

## Troubleshooting

- **401 / token rejected.** The token is invalid or expired (see the 24h note).
  Generate a new one and re-export `SMARTTHINGS_TOKEN`.
- **TV not found.** Run `npm run devices` to see what the account exposes. The app
  picks a device whose main component has an input-source capability
  (`samsungvd.mediaInputSource` or `mediaInputSource`); if your TV's id differs, set
  `deviceId` manually in `smartthings-config.json`.
- **Input won't change.** Run `npm run devices` and confirm the TV lists an
  input-source capability. The supported input ids/labels come straight from the TV;
  set `pcInput` to the exact id or label shown for the PC port.
- **TV won't turn on.** Make sure it powers on from the SmartThings app itself; if
  that fails, the TV isn't reachable by the cloud (check its network/standby setting).

## How it works

SmartThings REST API (`https://api.smartthings.com/v1`):

- `GET /devices` — find the TV (device with an input-source capability).
- `GET /devices/{id}/status` — read power state, current input, and supported inputs.
- `POST /devices/{id}/commands` — `switch.on` to power on, then
  `setInputSource("HDMI3")` to switch to the PC.
