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
npm run daemon         # stay running; trigger on global hotkeys (see below)
npm run login          # one-time OAuth authorize (auto-refreshing token)
npm run devices        # list account devices + capabilities (to identify the TV)
npm run reset          # forget the cached device id / token
npm run electron:dev   # run the daemon as a desktop tray app with a log window
```

### Daemon + global hotkey

`npm run daemon` runs forever and listens for two global hotkeys from anywhere:

| Action | macOS | Windows / Linux |
| --- | --- | --- |
| Wake the TV + switch to PC | **Cmd + Ctrl + E** | **Ctrl + Alt + E** |
| Turn the TV off, then sleep this PC | **Cmd + Ctrl + Q** | **Ctrl + Alt + Q** |

The off-and-sleep hotkey turns the TV off — but **only if it's currently on the PC input**, so
it won't switch off a TV you've put on another source — then waits 2 seconds and puts this PC to
sleep (`pmset sleepnow` on macOS, `SetSuspendState` on Windows, `systemctl suspend` on Linux).

The daemon also **wakes the TV automatically when this PC resumes from sleep**. It detects wake
with a simple heartbeat: a timer ticks every few seconds, and a large gap between ticks means the
process was frozen (the PC slept). On wake it turns the TV on (only if it was off) and switches to
PC, then pauses detection for 5 minutes so it can't re-fire. This works on all platforms — no
extra setup.

It uses [`uiohook-napi`](https://www.npmjs.com/package/uiohook-napi), which installs a
system-wide low-level keyboard hook (so on Windows the hotkey fires even when the app
isn't focused). A 1.5s cooldown prevents key auto-repeat from double-firing.

> **macOS:** global key capture requires **Accessibility** permission. The first run
> prompts — or grant it manually under **System Settings → Privacy & Security →
> Accessibility** for your terminal app (Terminal/iTerm). Without it the daemon runs but
> never sees the hotkey.

To keep it running across reboots, use a process manager (pm2), a macOS `launchd` agent,
or Windows Task Scheduler. See [Run on Windows startup](#run-on-windows-startup) below.

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

It runs the *exact same* daemon core as `npm run daemon` (global hotkeys, sleep/wake auto-wake,
boot reconcile) — the window only mirrors the log output and adds buttons.

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

> ⚠️ **`uiohook-napi` is a native module**, so the Windows exe must be built **on Windows**
> (native addons don't cross-compile from macOS/Linux). Run `npm install` then `npm run dist:win`
> on a Windows machine (or Windows CI). `electron-builder` rebuilds the addon for Electron's ABI
> automatically.
>
> To run `npm run electron:dev` locally for the first time, rebuild the addon for Electron with
> `npm run electron:rebuild` (otherwise you'll get a `NODE_MODULE_VERSION` mismatch).

## Run on Windows startup

Launch the app automatically when you log in. First decide which mode you want at
startup:

- **Daemon (recommended)** — `npm run daemon` stays running in the background so the
  **Ctrl + Alt + E** hotkey works any time after boot. Use the included
  `shortcuts/TV-DAEMON.vbs` launcher.
- **One-shot** — `npm start` runs once at log on (wakes the TV and switches it to PC),
  then exits. Use the included `shortcuts/TV-to-PC-NW.vbs` launcher.

> ⚠️ **Use OAuth for the token, not a PAT.** A startup launcher runs unattended, so a
> 24h PAT would break the next day. Run `npm run login` once first — it stores an
> **auto-refreshing** token in `smartthings-config.json` that survives reboots. (Env
> vars set in one terminal don't carry over to a Startup-folder launch anyway.)
> `cd tv && npm install` must have been run once so `node_modules` exists.

### Option A — Startup folder (simplest)

1. Press **Win + R**, type `shell:startup`, press Enter. This opens your per-user
   Startup folder; anything in it runs at log on.
2. Right-click the `.vbs` launcher you want (`shortcuts/TV-DAEMON.vbs` for the
   daemon) → **Show more options** → **Send to → Desktop (create shortcut)**, then move
   that shortcut into the Startup folder. (Putting a *shortcut* there, rather than the
   file itself, keeps the script in the repo.)
3. Log out and back in to test. The `.vbs` runs with no console window; while setting
   up, run `npm run daemon` in a terminal once to confirm the token works, since a
   hidden window shows no errors.

### Option B — Task Scheduler (more robust)

Better when you want auto-restart on failure or to run before/at a specific event.

1. Open **Task Scheduler** → **Create Task…** (not *Basic*).
2. **General:** name it `TV daemon`; tick **Run only when user is logged on**.
3. **Triggers:** New → **Begin the task: At log on** → your user.
4. **Actions:** New → **Start a program**:
   - **Program/script:** `wscript.exe`
   - **Add arguments:** `"shortcuts\TV-DAEMON.vbs"`
   - **Start in:** the full path to this project folder (e.g. `C:\Users\you\samsung-tv-control`).
     Using `wscript.exe` + the `.vbs` keeps it windowless; pointing the action straight
     at `npm` would flash a console.
5. **Settings:** optionally enable **If the task fails, restart every 1 minute** for the
   daemon.

To switch the TV at boot instead of running the daemon, point either method at
`shortcuts/TV-to-PC-NW.vbs`.

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
