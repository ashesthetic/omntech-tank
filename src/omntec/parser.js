'use strict';
/**
 * OMNTEC Response Parser
 *
 * Takes a raw Buffer from the serial port and returns a structured JS object,
 * or null if the buffer cannot be recognised.
 *
 * Supported response types:
 *   'I' – Inventory  (tank levels, volumes, temperatures)
 *   'A' – Alarms
 *   'D' – Delivery report
 */

const { ALARM_BITS } = require('./protocol');

// ─── Public entry point ───────────────────────────────────────────────────────
/**
 * @param {Buffer} buf
 * @returns {{ type, timestamp, ... } | null}
 */
function parseFrame(buf) {
	if (!Buffer.isBuffer(buf) || buf.length < 3) return null;

	// Strip SOH / ETX framing if present
	let payload = buf;
	const sohi = buf.indexOf(0x01);
	const etxi = buf.indexOf(0x03);
	if (sohi !== -1 && etxi > sohi) {
		payload = buf.slice(sohi + 1, etxi);
	}

	if (payload.length === 0) return null;

	const typeChar = String.fromCharCode(payload[0]).toUpperCase();
	const body = payload.slice(1);

	switch (typeChar) {
		case 'I': return parseInventory(body);
		case 'A': return parseAlarms(body);
		case 'D': return parseDelivery(body);
		default: return null;
	}
}

// ─── Inventory ────────────────────────────────────────────────────────────────
/**
 * Fixed-width ASCII record per tank (35 chars):
 *   TankID(2) Level(7) Water(5) Temp(5) Volume(7) Ullage(7) Flags(2)
 *
 * Encoding:
 *   Level   → integer × 0.01  (inches)
 *   Water   → integer × 0.01  (inches)
 *   Temp    → (integer − 10000) × 0.01  (°F)
 *   Volume  → integer × 0.1   (US gallons)
 *   Ullage  → integer × 0.1   (US gallons)
 *   Flags   → hex byte bitmask (see ALARM_BITS)
 */
const INV_RECORD_LEN = 35;

function parseInventory(body) {
	const str = body.toString('ascii');
	const tanks = [];

	for (let i = 0; i + INV_RECORD_LEN <= str.length; i += INV_RECORD_LEN) {
		const r = str.slice(i, i + INV_RECORD_LEN);

		const id = parseInt(r.slice(0, 2), 10);
		const level = parseInt(r.slice(2, 9), 10) / 100;
		const water = parseInt(r.slice(9, 14), 10) / 100;
		const tempRaw = parseInt(r.slice(14, 19), 10);
		const temp = (tempRaw - 10000) / 100;
		const volume = parseInt(r.slice(19, 26), 10) / 10;
		const ullage = parseInt(r.slice(26, 33), 10) / 10;
		const flags = parseInt(r.slice(33, 35), 16);

		if (!Number.isFinite(id) || id < 1 || id > 16) continue;
		if (!Number.isFinite(level)) continue;

		tanks.push({
			id,
			level: round2(level),
			waterLevel: round2(water),
			temperature: round2(temp),
			volume: round2(volume),
			ullage: round2(ullage),
			alarms: decodeAlarms(flags),
			activeAlarms: listActiveAlarms(flags),
			flagsRaw: r.slice(33, 35),
		});
	}

	if (tanks.length === 0) return null;
	return { type: 'inventory', timestamp: new Date().toISOString(), tanks };
}

// ─── Alarms ───────────────────────────────────────────────────────────────────
/**
 * Fixed-width record per tank (4 chars):
 *   TankID(2) Flags(2)
 */
function parseAlarms(body) {
	const str = body.toString('ascii');
	const alarms = [];

	for (let i = 0; i + 4 <= str.length; i += 4) {
		const id = parseInt(str.slice(i, i + 2), 10);
		const flags = parseInt(str.slice(i + 2, i + 4), 16);
		if (!Number.isFinite(id)) continue;
		alarms.push({ tankId: id, alarms: decodeAlarms(flags), activeAlarms: listActiveAlarms(flags) });
	}

	if (alarms.length === 0) return null;
	return { type: 'alarms', timestamp: new Date().toISOString(), alarms };
}

// ─── Delivery ─────────────────────────────────────────────────────────────────
/**
 * Fixed-width record (34 chars):
 *   TankID(2) Volume(8) StartTime(12) EndTime(12)
 */
function parseDelivery(body) {
	const str = body.toString('ascii');
	const deliveries = [];

	for (let i = 0; i + 34 <= str.length; i += 34) {
		const r = str.slice(i, i + 34);
		deliveries.push({
			tankId: parseInt(r.slice(0, 2), 10),
			volume: parseInt(r.slice(2, 10), 10) / 10,
			startTime: r.slice(10, 22).trim(),
			endTime: r.slice(22, 34).trim(),
		});
	}

	if (deliveries.length === 0) return null;
	return { type: 'delivery', timestamp: new Date().toISOString(), deliveries };
}

// ─── Helpers ──────────────────────────────────────────────────────────────────
function decodeAlarms(byte) {
	const out = {};
	for (const [bit, name] of Object.entries(ALARM_BITS)) {
		out[name] = !!(byte & Number(bit));
	}
	return out;
}

function listActiveAlarms(byte) {
	return Object.entries(ALARM_BITS)
		.filter(([bit]) => byte & Number(bit))
		.map(([, name]) => name);
}

function round2(n) {
	return Math.round(n * 100) / 100;
}

module.exports = { parseFrame };
