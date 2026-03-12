# Tank Data Monitor

Real-time dashboard for **OMNTEC tank monitoring devices** connected via USB serial port.

Built with Electron — packages to a native **macOS DMG** or **Windows installer**.

---

## Features

| Feature | Details |
|---|---|
| **Live Tank Dashboard** | SVG fill-gauges, level / volume / water / temperature per tank |
| **Alarm Panel** | Highlights High Level, Low Level, High Water, Overfill, Leak, Probe Error |
| **Raw Terminal** | Send custom OMNTEC commands and see hex + ASCII responses |
| **Data Logging** | Auto-saves all readings to dated JSON files in your user data folder |
| **CSV Export** | One-click export of all logs to a spreadsheet-friendly CSV |
| **Unit Toggle** | Imperial (in / gal / °F) ↔ Metric (mm / L / °C) |
| **Cross-platform** | macOS (x64 + Apple Silicon) and Windows (x64) |

---

## Quick Start

### Prerequisites

- **Node.js** 18+ — https://nodejs.org  
- **npm** (bundled with Node.js)  
- **Python 3** + **Xcode Command Line Tools** (macOS) or **Windows Build Tools** (Windows) — required to compile the `serialport` native module

### Install & Run

```bash
cd tank-data
npm install        # installs deps + rebuilds serialport for Electron
npm start          # launches the app
```

### Build distributable

```bash
# macOS  →  dist/  (DMG + ZIP for x64 and arm64)
npm run build:mac

# Windows →  dist/  (NSIS installer + portable EXE)
npm run build:win

# Both platforms at once
npm run build
```

> **Cross-compilation note:** Building a Windows installer on macOS requires Wine or a Windows CI runner. Use GitHub Actions or a Windows machine for official Windows builds.

---

## Connecting to an OMNTEC Device

1. Plug the OMNTEC USB serial adapter into your computer.
2. Launch the app → click **Connect** (top-right) or go to **Settings**.
3. Select the COM / tty port (the OMNTEC device usually shows as `CP210x` or `FTDI`).
4. Leave baud rate at **9600** (default for most OP-series devices).
5. Click **Connect**.

The app immediately sends an inventory poll (`I00`) and starts polling every 5 seconds.

### Protocol notes

| Setting | Default | Notes |
|---|---|---|
| Baud Rate | 9600 | OP-3000/5000 default |
| Data Bits | 8 | |
| Stop Bits | 1 | |
| Parity | None | |
| Parser | ETX Delimiter | Frames end with `0x03` |
| Poll Command | `I00` | Request all-tank inventory |

If your device uses a different baud rate or line ending, change them in **Settings** before connecting.

### Sending manual commands

Switch to the **Terminal** view, type an OMNTEC command body (e.g. `A00` for alarms, `D00` for delivery report) and press **Send**. The app wraps it in the correct SOH/ETX/checksum frame automatically. Switch the mode selector to **Raw Hex** to send arbitrary hex bytes.

---

## Project Structure

```
tank-data/
├── main.js               Electron main process, serial I/O, IPC handlers
├── preload.js            Secure contextBridge API
├── src/
│   ├── index.html        App shell
│   ├── renderer.js       UI logic (dashboard, alarms, terminal, logs)
│   ├── styles.css        Dark industrial theme
│   └── omntec/
│       ├── protocol.js   Frame builder & checksum validator
│       └── parser.js     Response parser (inventory, alarms, delivery)
├── assets/               App icons (add icon.icns / icon.ico / icon.png)
└── package.json          Dependencies & electron-builder config
```

---

## Adding App Icons

Place your icons in the `assets/` folder:

| File | Platform |
|---|---|
| `assets/icon.icns` | macOS |
| `assets/icon.ico`  | Windows |
| `assets/icon.png`  | Linux / fallback |

You can generate all three from a single 1024×1024 PNG using [electron-icon-maker](https://www.npmjs.com/package/electron-icon-maker) or https://cloudconvert.com.

---

## License

MIT
