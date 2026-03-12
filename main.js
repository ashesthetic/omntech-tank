'use strict';

const { app, BrowserWindow, ipcMain, dialog, shell } = require('electron');
const path = require('path');
const fs = require('fs');
const { Transform } = require('stream');

// ─── Lazy-require serialport so the app still opens even if rebuild failed ───
let SerialPort, DelimiterParser, ReadlineParser;
try {
	({ SerialPort } = require('serialport'));
	({ DelimiterParser } = require('@serialport/parser-delimiter'));
	({ ReadlineParser } = require('@serialport/parser-readline'));
} catch (e) {
	console.error('serialport load error:', e.message);
}

// ─── State ────────────────────────────────────────────────────────────────────
let mainWindow = null;
let activePort = null;
let activeParser = null;
let pollTimer = null;
let pollCommand = null;

// Line accumulator — collects CRLF lines until the device goes quiet
let reportLineBuffer = [];
let reportFlushTimer = null;

const LOG_DIR = path.join(app.getPath('userData'), 'logs');
const SETTINGS_FILE = path.join(app.getPath('userData'), 'settings.json');

// ─── Helpers ──────────────────────────────────────────────────────────────────
function ensureLogDir() {
	if (!fs.existsSync(LOG_DIR)) fs.mkdirSync(LOG_DIR, { recursive: true });
}

function send(channel, payload) {
	mainWindow?.webContents?.send(channel, payload);
}

// ─── Window ───────────────────────────────────────────────────────────────────
function createWindow() {
	mainWindow = new BrowserWindow({
		width: 1340,
		height: 840,
		minWidth: 960,
		minHeight: 640,
		titleBarStyle: process.platform === 'darwin' ? 'hiddenInset' : 'default',
		backgroundColor: '#0f172a',
		show: false,
		webPreferences: {
			preload: path.join(__dirname, 'preload.js'),
			contextIsolation: true,
			nodeIntegration: false,
			sandbox: false,
		},
	});

	mainWindow.loadFile(path.join(__dirname, 'src', 'index.html'));

	mainWindow.once('ready-to-show', () => {
		mainWindow.show();
		if (process.env.NODE_ENV === 'development') mainWindow.webContents.openDevTools();
	});

	mainWindow.on('closed', () => { mainWindow = null; });
}

app.whenReady().then(() => { ensureLogDir(); createWindow(); });

app.on('window-all-closed', () => {
	stopPolling();
	closePort();
	if (process.platform !== 'darwin') app.quit();
});

app.on('activate', () => {
	if (BrowserWindow.getAllWindows().length === 0) createWindow();
});

// ─── Serial port helpers ──────────────────────────────────────────────────────
function closePort() {
	return new Promise(resolve => {
		if (activePort && activePort.isOpen) {
			activePort.close(() => { activePort = null; activeParser = null; resolve(); });
		} else {
			activePort = null; activeParser = null; resolve();
		}
	});
}

function stopPolling() {
	if (pollTimer) { clearInterval(pollTimer); pollTimer = null; }
}

function startPolling(intervalMs) {
	stopPolling();
	pollTimer = setInterval(() => {
		if (activePort && activePort.isOpen && pollCommand) {
			writeAndEcho(pollCommand);
		}
	}, intervalMs);
}

// Write to port and echo the bytes to the terminal as a TX line
function writeAndEcho(data) {
	activePort.write(data, err => {
		if (err) { send('serial:error', err.message); return; }
		const buf = Buffer.isBuffer(data) ? data : Buffer.from(data);
		send('serial:raw', {
			direction: 'tx',
			hex: buf.toString('hex').toUpperCase().replace(/(.{2})/g, '$1 ').trim(),
			ascii: buf.toString('latin1').replace(/[^\x20-\x7E]/g, '.'),
			timestamp: new Date().toISOString(),
		});
	});
}

// Spy Transform: forwards every incoming byte chunk to the terminal
// BEFORE the delimiter parser buffers them, so partial/unchunked data is visible.
function createRawSpy() {
	return new Transform({
		transform(chunk, _enc, cb) {
			const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
			send('serial:raw', {
				direction: 'rx',
				hex: buf.toString('hex').toUpperCase().replace(/(.{2})/g, '$1 ').trim(),
				ascii: buf.toString('latin1').replace(/[^\x20-\x7E]/g, '.'),
				timestamp: new Date().toISOString(),
			});
			cb(null, buf);
		},
	});
}

// ─── IPC: port listing ────────────────────────────────────────────────────────
ipcMain.handle('serial:list', async () => {
	if (!SerialPort) return { success: false, error: 'serialport module not loaded' };
	try {
		const ports = await SerialPort.list();
		return { success: true, ports };
	} catch (err) {
		return { success: false, error: err.message };
	}
});

// ─── IPC: connect ─────────────────────────────────────────────────────────────
ipcMain.handle('serial:connect', async (_ev, cfg) => {
	if (!SerialPort) return { success: false, error: 'serialport module not loaded' };
	try {
		stopPolling();
		await closePort();

		activePort = new SerialPort({
			path: cfg.path,
			baudRate: cfg.baudRate || 9600,
			dataBits: cfg.dataBits || 8,
			stopBits: cfg.stopBits || 1,
			parity: cfg.parity || 'none',
			autoOpen: false,
		});

		// Spy transform: forwards raw bytes to the terminal as they arrive,
		// before the delimiter parser buffers them.
		const spy = createRawSpy();
		activePort.pipe(spy);

		// Choose parser: readline (CRLF) is the default for OMNTEC formatted reports.
		// Only use ETX delimiter if explicitly selected.
		if (cfg.parserMode === 'etx') {
			activeParser = spy.pipe(new DelimiterParser({ delimiter: Buffer.from([0x03]) }));
		} else {
			// OMNTEC devices in Data/Computer mode send CR+LF terminated lines
			activeParser = spy.pipe(new ReadlineParser({ delimiter: '\r\n' }));
		}

		activeParser.on('data', handleIncomingData);

		activePort.on('error', err => {
			send('serial:error', err.message);
			stopPolling();
		});

		activePort.on('close', () => {
			send('serial:disconnected', null);
			stopPolling();
		});

		await new Promise((resolve, reject) => {
			activePort.open(err => (err ? reject(err) : resolve()));
		});

		// I20100 = formatted inventory report, tanks 01–00 (all)
		pollCommand = buildOMNTECCommand('I20100');

		if (cfg.pollInterval > 0) startPolling(cfg.pollInterval);

		// Send an immediate poll (echoed to terminal)
		writeAndEcho(pollCommand);

		return { success: true };
	} catch (err) {
		return { success: false, error: err.message };
	}
});

// ─── IPC: disconnect ──────────────────────────────────────────────────────────
ipcMain.handle('serial:disconnect', async () => {
	try {
		stopPolling();
		await closePort();
		return { success: true };
	} catch (err) {
		return { success: false, error: err.message };
	}
});

// ─── IPC: send raw / command ──────────────────────────────────────────────────
ipcMain.handle('serial:send', async (_ev, { command, isHex }) => {
	if (!activePort || !activePort.isOpen) return { success: false, error: 'Port not connected' };
	try {
		const data = isHex
			? Buffer.from(command.replace(/\s+/g, ''), 'hex')
			: buildOMNTECCommand(command);

		await new Promise((resolve, reject) => {
			activePort.write(data, err => {
				if (err) { reject(err); return; }
				const buf = Buffer.isBuffer(data) ? data : Buffer.from(data);
				send('serial:raw', {
					direction: 'tx',
					hex: buf.toString('hex').toUpperCase().replace(/(.{2})/g, '$1 ').trim(),
					ascii: buf.toString('latin1').replace(/[^\x20-\x7E]/g, '.'),
					timestamp: new Date().toISOString(),
				});
				resolve();
			});
		});
		return { success: true };
	} catch (err) {
		return { success: false, error: err.message };
	}
});

// ─── IPC: logs ────────────────────────────────────────────────────────────────
ipcMain.handle('logs:list', () => {
	try {
		const files = fs.readdirSync(LOG_DIR).filter(f => f.endsWith('.json')).sort().reverse();
		return { success: true, files };
	} catch (err) {
		return { success: false, error: err.message };
	}
});

ipcMain.handle('logs:read', (_ev, filename) => {
	try {
		const data = JSON.parse(fs.readFileSync(path.join(LOG_DIR, filename), 'utf8'));
		return { success: true, data };
	} catch (err) {
		return { success: false, error: err.message };
	}
});

ipcMain.handle('logs:export-csv', async () => {
	try {
		const result = await dialog.showSaveDialog(mainWindow, {
			defaultPath: `tank-data-${new Date().toISOString().split('T')[0]}.csv`,
			filters: [{ name: 'CSV', extensions: ['csv'] }],
		});
		if (result.canceled) return { success: false, error: 'Cancelled' };

		// Aggregate all log files
		const files = fs.readdirSync(LOG_DIR).filter(f => f.endsWith('.json'));
		const rows = ['timestamp,tankId,level_in,waterLevel_in,temperature_f,volume_gal,ullage_gal,alarms'];
		for (const file of files) {
			const entries = JSON.parse(fs.readFileSync(path.join(LOG_DIR, file), 'utf8'));
			for (const entry of entries) {
				for (const t of (entry.tanks || [])) {
					rows.push([
						entry.timestamp, t.id, t.level, t.waterLevel,
						t.temperature, t.volume, t.ullage,
						JSON.stringify(t.alarms).replace(/,/g, ';'),
					].join(','));
				}
			}
		}
		fs.writeFileSync(result.filePath, rows.join('\n'));
		shell.showItemInFolder(result.filePath);
		return { success: true, path: result.filePath };
	} catch (err) {
		return { success: false, error: err.message };
	}
});

ipcMain.handle('logs:open-folder', () => {
	shell.openPath(LOG_DIR);
	return { success: true };
});

// ─── IPC: settings ──────────────────────────────────────────────────
ipcMain.handle('settings:load', () => {
	try {
		if (fs.existsSync(SETTINGS_FILE)) {
			return { success: true, settings: JSON.parse(fs.readFileSync(SETTINGS_FILE, 'utf8')) };
		}
		return { success: true, settings: null };
	} catch (err) {
		return { success: false, error: err.message };
	}
});

ipcMain.handle('settings:save', (_ev, settings) => {
	try {
		fs.writeFileSync(SETTINGS_FILE, JSON.stringify(settings, null, 2));
		return { success: true };
	} catch (err) {
		return { success: false, error: err.message };
	}
});

// ─── Incoming data handler ────────────────────────────────────────────────────
// Called once per CRLF-terminated line by the ReadlineParser.
function handleIncomingData(raw) {
	// Raw bytes are already forwarded to the terminal by the spy transform.
	// Strip non-printable characters (SOH, control codes) and accumulate the line.
	const line = (Buffer.isBuffer(raw) ? raw.toString('ascii') : String(raw))
		.replace(/[^\x09\x20-\x7E]/g, '');

	reportLineBuffer.push(line);

	// After 300 ms of silence, treat the accumulated lines as one complete report
	if (reportFlushTimer) clearTimeout(reportFlushTimer);
	reportFlushTimer = setTimeout(flushReportBuffer, 300);
}

function flushReportBuffer() {
	reportFlushTimer = null;
	const lines = reportLineBuffer.slice();
	reportLineBuffer = [];
	if (lines.length === 0) return;

	try {
		const parsed = parseFormattedReport(lines);
		if (parsed) {
			send('omntec:data', parsed);
			appendLog(parsed);
		}
	} catch (e) {
		console.error('OMNTEC parse error:', e.message);
	}
}

/**
 * Parse the human-readable inventory report that OMNTEC devices send.
 *
 * Expected format (after the date/time header and column header):
 *   "  1  Diesel                    4097      4144    16840   865.1      0.0    1.61"
 * Columns: TANK  PRODUCT  VOLUME  TC-VOLUME  ULLAGE  HEIGHT  WATER  TEMP
 */
function parseFormattedReport(lines) {
	const tanks = [];
	let headerFound = false;
	let deviceTime = null;

	for (const raw of lines) {
		const line = raw.trim();
		if (!line) continue;

		// Capture date/time header e.g. "MAR 11, 2026  10:58 PM"
		if (!deviceTime && /[A-Z]{3}\s+\d+,\s+\d{4}/i.test(line)) {
			deviceTime = line;
			continue;
		}

		// Detect column header line
		if (/TANK\s+PRODUCT/i.test(line)) {
			headerFound = true;
			continue;
		}

		if (!headerFound) continue;

		// Tank data row: id + product name (lazy) + 6 numeric values separated by spaces
		const match = line.match(
			/^(\d{1,2})\s+(.*?)\s{2,}([\d.]+)\s+([\d.]+)\s+([\d.]+)\s+([\d.]+)\s+([\d.]+)\s+([\d.]+)\s*$/
		);
		if (!match) continue;

		const id = parseInt(match[1], 10);
		const product = match[2].trim();
		const volume = parseFloat(match[3]);
		const tcVolume = parseFloat(match[4]);
		const ullage = parseFloat(match[5]);
		const height = parseFloat(match[6]) / 10;  // device sends tenths-of-inch
		const water = parseFloat(match[7]);
		const temp = parseFloat(match[8]);

		if (!Number.isFinite(id) || id < 1 || id > 16) continue;
		if (!Number.isFinite(volume) || !Number.isFinite(height)) continue;

		tanks.push({
			id,
			product,
			level: height,
			waterLevel: water,
			temperature: temp,
			volume,
			tcVolume,
			ullage,
			alarms: {},
			activeAlarms: [],
		});
	}

	if (tanks.length === 0) return null;
	return { type: 'inventory', timestamp: new Date().toISOString(), deviceTime, tanks };
}

// ─── OMNTEC Protocol ──────────────────────────────────────────────────────────
/**
 * Build a framed OMNTEC command.
 * Frame:  SOH(01) + body_ascii + ETX(03) + XOR_checksum_2hex + CR(0D)
 */
function buildOMNTECCommand(cmd) {
	const body = Buffer.from(cmd, 'ascii');
	let xor = 0;
	for (const b of body) xor ^= b;
	const cs = xor.toString(16).toUpperCase().padStart(2, '0');
	return Buffer.concat([
		Buffer.from([0x01]),
		body,
		Buffer.from([0x03]),
		Buffer.from(cs, 'ascii'),
		Buffer.from([0x0d]),
	]);
}

/**
 * Parse a raw frame received from the OMNTEC device.
 * Returns a structured object or null if the frame cannot be parsed.
 */
function parseOMNTECFrame(buf) {
	// Locate SOH … ETX boundaries (SOH may be stripped by the delimiter parser)
	let start = buf.indexOf(0x01);
	let end = buf.indexOf(0x03);

	// If no SOH found assume the buffer starts right after SOH (already stripped)
	const payload = (start !== -1 && end !== -1)
		? buf.slice(start + 1, end)
		: buf;                           // raw payload without framing

	if (payload.length < 2) return null;

	const typeChar = String.fromCharCode(payload[0]).toUpperCase();

	switch (typeChar) {
		case 'I': return parseInventory(payload.slice(1));
		case 'A': return parseAlarms(payload.slice(1));
		case 'D': return parseDelivery(payload.slice(1));
		default: return null;
	}
}

/* ── Inventory response ─────────────────────────────────────────────────────
   Each tank record (ASCII, fixed-width):
	 TankID(2) Level(7) WaterLevel(5) Temp(5) Volume(7) Ullage(7) Flags(2)
   Levels are in 1/100 inch; volumes in 1/10 gallon; temp = raw−10000 in 1/100 °F
*/
function parseInventory(payload) {
	const str = payload.toString('ascii');
	const tanks = [];
	// 2+7+5+5+7+7+2 = 35 chars per tank
	const RECORD = 35;
	for (let i = 0; i + RECORD <= str.length; i += RECORD) {
		const rec = str.slice(i, i + RECORD);
		const id = parseInt(rec.slice(0, 2), 10);
		const level = parseInt(rec.slice(2, 9), 10) / 100;
		const water = parseInt(rec.slice(9, 14), 10) / 100;
		const tempRaw = parseInt(rec.slice(14, 19), 10);
		const temp = (tempRaw - 10000) / 100;
		const volume = parseInt(rec.slice(19, 26), 10) / 10;
		const ullage = parseInt(rec.slice(26, 33), 10) / 10;
		const flagsByte = parseInt(rec.slice(33, 35), 16);

		if (!Number.isFinite(id) || id < 1 || id > 16) continue;

		tanks.push({
			id, level, waterLevel: water, temperature: temp,
			volume, ullage,
			alarms: decodeAlarms(flagsByte),
			flagsRaw: rec.slice(33, 35),
		});
	}
	if (tanks.length === 0) return null;
	return { type: 'inventory', timestamp: new Date().toISOString(), tanks };
}

/* ── Alarm response ─────────────────────────────────────────────────────────*/
function parseAlarms(payload) {
	const str = payload.toString('ascii');
	const alarms = [];
	// 2+2 = 4 chars per tank
	for (let i = 0; i + 4 <= str.length; i += 4) {
		const id = parseInt(str.slice(i, i + 2), 10);
		const flags = parseInt(str.slice(i + 2, i + 4), 16);
		alarms.push({ tankId: id, alarms: decodeAlarms(flags) });
	}
	if (alarms.length === 0) return null;
	return { type: 'alarms', timestamp: new Date().toISOString(), alarms };
}

/* ── Delivery response ───────────────────────────────────────────────────────*/
function parseDelivery(payload) {
	const str = payload.toString('ascii');
	// TankID(2) Volume(8) StartTime(12) EndTime(12)
	const RECORD = 34;
	const deliveries = [];
	for (let i = 0; i + RECORD <= str.length; i += RECORD) {
		const rec = str.slice(i, i + RECORD);
		deliveries.push({
			tankId: parseInt(rec.slice(0, 2), 10),
			volume: parseInt(rec.slice(2, 10), 10) / 10,
			startTime: rec.slice(10, 22).trim(),
			endTime: rec.slice(22, 34).trim(),
		});
	}
	if (deliveries.length === 0) return null;
	return { type: 'delivery', timestamp: new Date().toISOString(), deliveries };
}

/* ── Alarm flag bitmask ─────────────────────────────────────────────────────*/
function decodeAlarms(byte) {
	return {
		highLevel: !!(byte & 0x01),
		lowLevel: !!(byte & 0x02),
		highWater: !!(byte & 0x04),
		overfill: !!(byte & 0x08),
		leak: !!(byte & 0x10),
		probeError: !!(byte & 0x20),
		deliveryActive: !!(byte & 0x40),
		sensorFault: !!(byte & 0x80),
	};
}

// ─── Logging ─────────────────────────────────────────────────────────────────
function appendLog(entry) {
	try {
		const today = new Date().toISOString().split('T')[0];
		const logFile = path.join(LOG_DIR, `${today}.json`);
		let logs = [];
		if (fs.existsSync(logFile)) {
			try { logs = JSON.parse(fs.readFileSync(logFile, 'utf8')); } catch (_) { }
		}
		logs.push(entry);
		if (logs.length > 14400) logs = logs.slice(-14400); // ~24 h at 6-second poll
		fs.writeFileSync(logFile, JSON.stringify(logs));
	} catch (_) { }
}
