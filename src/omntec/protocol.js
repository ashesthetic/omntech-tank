'use strict';
/**
 * OMNTEC Protocol Constants & Command Builders
 * Covers the OP-3000 / OP-5000 / OmniSite serial ASCII protocol.
 *
 * Frame format:
 *   SOH(01h)  +  ASCII body  +  ETX(03h)  +  XOR-checksum-2hex  +  CR(0Dh)
 */

const SOH = 0x01;
const ETX = 0x03;
const CR = 0x0d;

/** Baud-rate presets that OMNTEC devices commonly use */
const BAUD_RATES = [9600, 19200, 38400, 57600, 115200, 2400, 4800];

/** Alarm bit definitions (flagsByte) */
const ALARM_BITS = {
	0x01: 'High Level',
	0x02: 'Low Level',
	0x04: 'High Water',
	0x08: 'Overfill',
	0x10: 'Leak Detected',
	0x20: 'Probe Error',
	0x40: 'Delivery Active',
	0x80: 'Sensor Fault',
};

/** OMNTEC command mnemonics */
const COMMANDS = {
	INVENTORY_ALL: 'I00',   // Read all tank levels / volumes / temps
	INVENTORY_TANK: (n) => `I${String(n).padStart(2, '0')}`,
	ALARM_STATUS: 'A00',   // Read all alarm statuses
	DELIVERY_REPORT: 'D00',   // Delivery data
	TEST: 'T00',   // Self-test
	TIME_SYNC: (ts) => `S${ts}`,  // ts = YYMMDDHHmmss
};

/**
 * Build a framed OMNTEC command buffer.
 * @param {string} body  ASCII command body, e.g. "I00"
 * @returns {Buffer}
 */
function buildCommand(body) {
	const bodyBuf = Buffer.from(body, 'ascii');
	let xor = 0;
	for (const b of bodyBuf) xor ^= b;
	const cs = xor.toString(16).toUpperCase().padStart(2, '0');
	return Buffer.concat([
		Buffer.from([SOH]),
		bodyBuf,
		Buffer.from([ETX]),
		Buffer.from(cs, 'ascii'),
		Buffer.from([CR]),
	]);
}

/**
 * Validate the XOR checksum of a received frame.
 * @param {Buffer} frame  Raw frame including SOH…ETX + 2-byte checksum
 * @returns {boolean}
 */
function validateChecksum(frame) {
	const start = frame.indexOf(SOH);
	const end = frame.indexOf(ETX);
	if (start === -1 || end === -1 || end <= start) return false;

	const body = frame.slice(start + 1, end);
	let expected = 0;
	for (const b of body) expected ^= b;

	const receivedHex = frame.slice(end + 1, end + 3).toString('ascii');
	const received = parseInt(receivedHex, 16);
	return expected === received;
}

module.exports = { BAUD_RATES, ALARM_BITS, COMMANDS, buildCommand, validateChecksum };
