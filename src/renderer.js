'use strict';
/* ═══════════════════════════════════════════════════════════════════════════
   Tank Data Monitor – Renderer Process
   ═══════════════════════════════════════════════════════════════════════════ */

const api = window.tankAPI;

// ─── State ────────────────────────────────────────────────────────────────────
let connected = false;
let units = 'imperial';   // 'imperial' | 'metric'
let tankData = {};           // { [id]: latestTankObject }
let alarmLog = [];           // { timestamp, tankId, alarm }[]
let termLines = 0;
const MAX_TERM = 500;

// ─── Init ─────────────────────────────────────────────────────────────────────
document.addEventListener('DOMContentLoaded', () => {
	initClock();
	initNav();
	initConnectModal();
	initSettings();
	initTerminal();
	initLogs();
	setupIPCListeners();
	refreshPorts(document.getElementById('portSelect'));
	refreshPorts(document.getElementById('qcPortSelect'));
	syncUnitsFromSelect();
});

// ─── Clock ────────────────────────────────────────────────────────────────────
function initClock() {
	const el = document.getElementById('clock');
	const tick = () => {
		el.textContent = new Date().toLocaleTimeString('en-US', { hour12: false });
	};
	tick();
	setInterval(tick, 1000);
}

// ─── Navigation ───────────────────────────────────────────────────────────────
const VIEW_TITLES = {
	dashboard: 'Dashboard',
	tanks: 'Tanks',
	alarms: 'Alarms',
	terminal: 'Terminal',
	logs: 'Data Logs',
	settings: 'Settings',
};

function initNav() {
	document.querySelectorAll('.nav-item').forEach(btn => {
		btn.addEventListener('click', () => switchView(btn.dataset.view));
	});
}

function switchView(name) {
	document.querySelectorAll('.nav-item').forEach(b => b.classList.toggle('active', b.dataset.view === name));
	document.querySelectorAll('.view').forEach(v => v.classList.toggle('active', v.id === `view-${name}`));
	document.getElementById('pageTitle').textContent = VIEW_TITLES[name] || name;

	if (name === 'logs') loadLogFileList();
}

// ─── IPC Listeners ────────────────────────────────────────────────────────────
function setupIPCListeners() {
	api.onRawData(handleRawData);
	api.onOMNTECData(handleOMNTECData);
	api.onSerialError(handleSerialError);
	api.onDisconnected(handleDisconnected);
}

function handleRawData(data) {
	const isTx = data.direction === 'tx';
	const cls = isTx ? 'tx' : 'rx';
	const label = isTx ? 'TX' : 'RX';
	appendTermLine(
		`<span class="ts">${shortTime(data.timestamp)}</span>` +
		`<span class="hex">${label} HEX: ${data.hex}</span>  ` +
		`<span class="asc">ASCII: ${escHtml(data.ascii)}</span>`,
		cls
	);
}

function handleOMNTECData(data) {
	if (data.type === 'inventory') {
		data.tanks.forEach(t => { tankData[t.id] = { ...t, lastSeen: data.timestamp }; });
		renderDashboard();
		renderTankTable();
		renderAlarms();
		updateStats(data.timestamp);
		document.getElementById('tankCountBadge').textContent = Object.keys(tankData).length;
	}
	if (data.type === 'alarms') {
		data.alarms.forEach(a => {
			a.activeAlarms.forEach(name => {
				alarmLog.unshift({ timestamp: data.timestamp, tankId: a.tankId, alarm: name });
			});
		});
		renderAlarms();
	}
}

function handleSerialError(msg) {
	appendTermLine(`ERROR: ${escHtml(msg)}`, 'err');
	showToast(msg, 'error');
	setConnectionUI(false);
}

function handleDisconnected() {
	connected = false;
	setConnectionUI(false);
	showToast('Device disconnected', 'info');
}

// ─── Connection ───────────────────────────────────────────────────────────────
async function refreshPorts(selectEl) {
	if (!selectEl) return;
	const res = await api.listPorts();
	const prev = selectEl.value;
	while (selectEl.options.length > 1) selectEl.remove(1);
	if (res.success && res.ports.length > 0) {
		res.ports.forEach(p => {
			const opt = document.createElement('option');
			opt.value = p.path;
			opt.textContent = `${p.path}${p.manufacturer ? `  (${p.manufacturer})` : ''}`;
			selectEl.appendChild(opt);
		});
		if (prev) selectEl.value = prev;
	} else {
		const opt = document.createElement('option');
		opt.value = ''; opt.textContent = 'No ports found'; opt.disabled = true;
		selectEl.appendChild(opt);
	}
}

async function doConnect(cfg) {
	setConnectionUI('connecting');
	appendTermLine(`Connecting to ${cfg.path} @ ${cfg.baudRate} baud…`, 'dim');

	const res = await api.connect(cfg);
	if (res.success) {
		connected = true;
		setConnectionUI(true, cfg.path);
		appendTermLine(`Connected ✓`, 'tx');
		showToast(`Connected to ${cfg.path}`, 'success');
	} else {
		setConnectionUI(false);
		appendTermLine(`Connection failed: ${escHtml(res.error)}`, 'err');
		showToast(res.error, 'error');
	}
}

async function doDisconnect() {
	await api.disconnect();
	connected = false;
	setConnectionUI(false);
	appendTermLine('Disconnected.', 'dim');
	showToast('Disconnected', 'info');
}

function setConnectionUI(state, port) {
	const dot = document.getElementById('statusDot');
	const label = document.getElementById('statusLabel');
	const portL = document.getElementById('connPortLabel');
	const topBtn = document.getElementById('connectBtn');

	dot.className = 'status-dot';
	topBtn.textContent = 'Connect';
	topBtn.onclick = () => showQuickConnectModal();

	if (state === true) {
		dot.classList.add('connected');
		label.textContent = 'Connected';
		portL.textContent = port || '';
		topBtn.textContent = 'Disconnect';
		topBtn.onclick = doDisconnect;
		document.getElementById('settingsConnectBtn').classList.add('hidden');
		document.getElementById('settingsDisconnectBtn').classList.remove('hidden');
	} else if (state === 'connecting') {
		dot.classList.add('connecting');
		label.textContent = 'Connecting…';
		portL.textContent = '';
	} else {
		dot.classList.add('disconnected');
		label.textContent = 'Disconnected';
		portL.textContent = '';
		document.getElementById('settingsConnectBtn').classList.remove('hidden');
		document.getElementById('settingsDisconnectBtn').classList.add('hidden');
	}
}

// ─── Quick Connect Modal ──────────────────────────────────────────────────────
function initConnectModal() {
	document.getElementById('connectBtn').addEventListener('click', () => {
		if (connected) { doDisconnect(); return; }
		showQuickConnectModal();
	});

	document.getElementById('qcRefreshBtn').addEventListener('click', () => {
		refreshPorts(document.getElementById('qcPortSelect'));
	});

	document.getElementById('qcConnectBtn').addEventListener('click', async () => {
		const port = document.getElementById('qcPortSelect').value;
		const baud = parseInt(document.getElementById('qcBaudSelect').value, 10);
		if (!port) { showToast('Please select a port', 'error'); return; }
		hideQuickConnectModal();
		await doConnect({
			path: port, baudRate: baud,
			dataBits: 8, stopBits: 1, parity: 'none',
			parserMode: 'readline', pollInterval: 5000,
		});
	});

	document.getElementById('qcCancelBtn').addEventListener('click', hideQuickConnectModal);
	document.getElementById('modalClose').addEventListener('click', hideQuickConnectModal);
	document.getElementById('quickConnectModal').addEventListener('click', e => {
		if (e.target.id === 'quickConnectModal') hideQuickConnectModal();
	});
}

function showQuickConnectModal() {
	refreshPorts(document.getElementById('qcPortSelect'));
	document.getElementById('quickConnectModal').classList.remove('hidden');
}
function hideQuickConnectModal() {
	document.getElementById('quickConnectModal').classList.add('hidden');
}

// ─── Settings View ────────────────────────────────────────────────────────────
function initSettings() {
	document.getElementById('refreshPortsBtn').addEventListener('click', () => {
		refreshPorts(document.getElementById('portSelect'));
	});

	document.getElementById('settingsConnectBtn').addEventListener('click', async () => {
		const port = document.getElementById('portSelect').value;
		if (!port) { showToast('Please select a port', 'error'); return; }
		await doConnect({
			path: port,
			baudRate: parseInt(document.getElementById('baudSelect').value, 10),
			dataBits: parseInt(document.getElementById('dataBitsSelect').value, 10),
			stopBits: parseInt(document.getElementById('stopBitsSelect').value, 10),
			parity: document.getElementById('paritySelect').value,
			parserMode: document.getElementById('parserModeSelect').value,
			pollInterval: parseInt(document.getElementById('pollIntervalInput').value, 10),
		});
	});

	document.getElementById('settingsDisconnectBtn').addEventListener('click', doDisconnect);

	document.getElementById('unitsSelect').addEventListener('change', e => {
		units = e.target.value;
		renderDashboard();
		renderTankTable();
	});

	document.getElementById('stat-poll').textContent = '5 s';
	document.getElementById('pollIntervalInput').addEventListener('input', e => {
		const ms = parseInt(e.target.value, 10);
		if (ms >= 500) document.getElementById('stat-poll').textContent = (ms / 1000).toFixed(1) + ' s';
	});
}

function syncUnitsFromSelect() {
	units = document.getElementById('unitsSelect').value;
}

// ─── Dashboard ────────────────────────────────────────────────────────────────
function renderDashboard() {
	const grid = document.getElementById('tankGrid');
	const tanks = Object.values(tankData).sort((a, b) => a.id - b.id);

	if (tanks.length === 0) {
		grid.innerHTML = `
      <div class="empty-state">
        <svg viewBox="0 0 64 64" fill="none">
          <rect x="16" y="10" width="32" height="42" rx="4" stroke="#475569" stroke-width="2" stroke-dasharray="4 3"/>
          <path d="M26 26l12 12M38 26L26 38" stroke="#475569" stroke-width="2" stroke-linecap="round"/>
        </svg>
        <p>No tanks detected.<br/>Connect to an OMNTEC device to begin monitoring.</p>
      </div>`;
		return;
	}

	grid.innerHTML = tanks.map(t => buildTankCard(t)).join('');
}

function buildTankCard(t) {
	const fillPct = calcFillPct(t);
	const alarms = t.activeAlarms || [];
	const hasAlarm = alarms.length > 0;

	const dispLevel = cvtLevel(t.level);
	const dispWater = cvtLevel(t.waterLevel);
	const dispTemp = cvtTemp(t.temperature);
	const dispVol = cvtVolume(t.volume);
	const dispUllage = cvtVolume(t.ullage);

	const gaugeColor = hasAlarm ? '#ef4444' : fillColor(fillPct);

	const productLabel = t.product ? t.product : `Tank ${t.id}`;
	return `
  <div class="tank-card ${hasAlarm ? 'has-alarm' : ''}">
    <div class="tank-card-header">
      <span>${escHtml(productLabel)}</span>
      <span class="tank-id-badge">#${String(t.id).padStart(2, '0')}</span>
    </div>
    <div class="gauge-wrap">
      ${buildSVGGauge(fillPct, gaugeColor)}
    </div>
    <div class="tank-stats">
      <div class="tank-stat"><span class="lbl">Level</span><span class="val">${dispLevel.val} ${dispLevel.unit}</span></div>
      <div class="tank-stat"><span class="lbl">Volume</span><span class="val">${dispVol.val} ${dispVol.unit}</span></div>
      <div class="tank-stat"><span class="lbl">Water</span><span class="val">${dispWater.val} ${dispWater.unit}</span></div>
      <div class="tank-stat"><span class="lbl">Temp</span><span class="val">${dispTemp.val}${dispTemp.unit}</span></div>
      <div class="tank-stat"><span class="lbl">Ullage</span><span class="val">${dispUllage.val} ${dispUllage.unit}</span></div>
    </div>
    ${alarms.length > 0 ? `<div class="alarm-pills">${alarms.map(a => `<span class="alarm-pill">${a}</span>`).join('')}</div>` : ''}
  </div>`;
}

function buildSVGGauge(pct, color) {
	// Circular arc gauge
	const r = 45;
	const cx = 60; const cy = 60;
	const sw = 10;
	// Arc spans 240° (starts at 150°, ends at 390° / 30°)
	const startAngle = 150;
	const sweep = 240;
	const angle = startAngle + (pct / 100) * sweep;

	function polarToXY(deg, radius) {
		const rad = (deg - 90) * Math.PI / 180;
		return { x: cx + radius * Math.cos(rad), y: cy + radius * Math.sin(rad) };
	}

	function describeArc(start, end, r) {
		const s = polarToXY(start, r);
		const e = polarToXY(end, r);
		const la = (end - start <= 180) ? 0 : 1;
		return `M ${s.x} ${s.y} A ${r} ${r} 0 ${la} 1 ${e.x} ${e.y}`;
	}

	const bgPath = describeArc(startAngle, startAngle + sweep, r);
	const fillPath = pct > 0 ? describeArc(startAngle, Math.min(angle, startAngle + sweep - 0.01), r) : '';

	return `
  <svg class="gauge-svg" viewBox="0 0 120 90">
    <path d="${bgPath}" fill="none" stroke="#1e293b" stroke-width="${sw}" stroke-linecap="round"/>
    ${fillPath ? `<path d="${fillPath}" fill="none" stroke="${color}" stroke-width="${sw}" stroke-linecap="round"/>` : ''}
    <text class="gauge-pct" x="${cx}" y="${cy}" style="fill:${color};font-size:18px;font-weight:800;font-family:Inter,sans-serif">${pct}%</text>
  </svg>`;
}

// ─── Tank Table ───────────────────────────────────────────────────────────────
function renderTankTable() {
	const tbody = document.getElementById('tankTableBody');
	const tanks = Object.values(tankData).sort((a, b) => a.id - b.id);

	if (tanks.length === 0) {
		tbody.innerHTML = '<tr><td colspan="9" class="table-empty">No data — connect to a device</td></tr>';
		return;
	}

	tbody.innerHTML = tanks.map(t => {
		const pct = calcFillPct(t);
		const alarms = t.activeAlarms || [];
		const barClass = pct < 10 ? 'crit' : pct < 20 ? 'warn' : '';
		const stClass = alarms.length > 0 ? 'status-alarm' : 'status-ok';
		const stText = alarms.length > 0 ? `⚠ ${alarms.join(', ')}` : '✓ Normal';

		return `<tr>
      <td>#${t.id}</td>
      <td>${escHtml(t.product || '—')}</td>
      <td>${cvtLevel(t.level).val}</td>
      <td>${cvtLevel(t.waterLevel).val}</td>
      <td>${cvtTemp(t.temperature).val}</td>
      <td>${cvtVolume(t.volume).val}</td>
      <td>${cvtVolume(t.ullage).val}</td>
      <td class="fill-bar-cell">
        <div class="fill-bar-wrap">
          <div class="fill-bar-bg"><div class="fill-bar-fg ${barClass}" style="width:${pct}%"></div></div>
          <span class="fill-bar-label">${pct}%</span>
        </div>
      </td>
      <td class="${stClass}">${stText}</td>
    </tr>`;
	}).join('');
}

// ─── Alarms View ──────────────────────────────────────────────────────────────
function renderAlarms() {
	const container = document.getElementById('alarmList');
	const badge = document.getElementById('alarmCountBadge');
	const statEl = document.getElementById('stat-alarms');

	// Collect active alarms from current tank state
	const active = [];
	Object.values(tankData).forEach(t => {
		(t.activeAlarms || []).forEach(name => {
			active.push({ tankId: t.id, alarm: name, timestamp: t.lastSeen });
		});
	});

	// Update badge & stat
	if (active.length > 0) {
		badge.textContent = active.length;
		badge.classList.remove('hidden');
		statEl.textContent = active.length;
		statEl.classList.add('has-alarms');
	} else {
		badge.classList.add('hidden');
		statEl.textContent = '0';
		statEl.classList.remove('has-alarms');
	}

	if (active.length === 0) {
		container.innerHTML = `
      <div class="empty-state">
        <svg viewBox="0 0 64 64" fill="none">
          <circle cx="32" cy="32" r="24" stroke="#22c55e" stroke-width="2"/>
          <path d="M22 32l7 7 13-14" stroke="#22c55e" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"/>
        </svg>
        <p>No active alarms</p>
      </div>`;
		return;
	}

	container.innerHTML = active.map(a => `
    <div class="alarm-item">
      <div class="alarm-icon">⚠</div>
      <div class="alarm-info">
        <div class="alarm-title">${escHtml(a.alarm)}</div>
        <div class="alarm-meta">Tank #${a.tankId} · ${shortTime(a.timestamp)}</div>
      </div>
    </div>`).join('');
}

// ─── Stats ────────────────────────────────────────────────────────────────────
function updateStats(timestamp) {
	document.getElementById('stat-tanks').textContent = Object.keys(tankData).length;
	document.getElementById('stat-time').textContent = shortTime(timestamp);
}

// ─── Terminal ─────────────────────────────────────────────────────────────────
function initTerminal() {
	document.getElementById('cmdSendBtn').addEventListener('click', sendCommand);
	document.getElementById('cmdInput').addEventListener('keydown', e => { if (e.key === 'Enter') sendCommand(); });
	document.getElementById('termClearBtn').addEventListener('click', () => {
		document.getElementById('terminal').innerHTML = '';
		termLines = 0;
	});
}

async function sendCommand() {
	const input = document.getElementById('cmdInput');
	const modeEl = document.getElementById('cmdMode');
	const cmd = input.value.trim();
	if (!cmd) return;

	if (!connected) { showToast('Not connected', 'error'); return; }

	const isHex = modeEl.value === 'hex';
	appendTermLine(`TX: ${escHtml(cmd)}`, 'tx');
	input.value = '';

	const res = await api.send({ command: cmd, isHex });
	if (!res.success) {
		appendTermLine(`Send error: ${escHtml(res.error)}`, 'err');
		showToast(res.error, 'error');
	}
}

function appendTermLine(html, cls = '') {
	const term = document.getElementById('terminal');
	const line = document.createElement('div');
	line.className = `terminal-line ${cls}`;
	line.innerHTML = html;
	term.appendChild(line);
	termLines++;

	// Prune oldest lines
	while (termLines > MAX_TERM) {
		term.removeChild(term.firstChild);
		termLines--;
	}
	term.scrollTop = term.scrollHeight;
}

// ─── Logs View ────────────────────────────────────────────────────────────────
function initLogs() {
	document.getElementById('loadLogBtn').addEventListener('click', loadSelectedLog);
	document.getElementById('exportCsvBtn').addEventListener('click', async () => {
		const res = await api.exportCSV();
		if (res.success) showToast('CSV exported', 'success');
		else if (res.error !== 'Cancelled') showToast(res.error, 'error');
	});
	document.getElementById('openLogFolderBtn').addEventListener('click', () => api.openLogsFolder());
}

async function loadLogFileList() {
	const sel = document.getElementById('logFileSelect');
	const res = await api.listLogs();
	while (sel.options.length > 1) sel.remove(1);
	if (res.success) {
		res.files.forEach(f => {
			const opt = document.createElement('option');
			opt.value = f; opt.textContent = f.replace('.json', '');
			sel.appendChild(opt);
		});
	}
}

async function loadSelectedLog() {
	const filename = document.getElementById('logFileSelect').value;
	if (!filename) { showToast('Select a log file first', 'error'); return; }

	const res = await api.readLog(filename);
	if (!res.success) { showToast(res.error, 'error'); return; }

	const tbody = document.getElementById('logTableBody');
	const rows = [];

	for (const entry of res.data) {
		if (entry.type !== 'inventory') continue;
		for (const t of (entry.tanks || [])) {
			rows.push(`<tr>
        <td>${shortTime(entry.timestamp)}</td>
        <td>#${t.id}</td>
        <td>${cvtLevel(t.level).val}</td>
        <td>${cvtLevel(t.waterLevel).val}</td>
        <td>${cvtTemp(t.temperature).val}</td>
        <td>${cvtVolume(t.volume).val}</td>
        <td>${cvtVolume(t.ullage).val}</td>
        <td>${(t.activeAlarms || []).join(', ') || '—'}</td>
      </tr>`);
		}
	}

	tbody.innerHTML = rows.length > 0
		? rows.join('')
		: '<tr><td colspan="8" class="table-empty">No inventory records in this log file</td></tr>';
}

// ─── Unit Conversion ──────────────────────────────────────────────────────────
function cvtLevel(inches) {
	if (units === 'metric') return { val: (inches * 25.4).toFixed(1), unit: 'mm' };
	return { val: inches.toFixed(2), unit: 'in' };
}
function cvtVolume(litres) {
	// Device already reports in litres
	return { val: parseFloat(litres).toFixed(1), unit: 'L' };
}
function cvtTemp(f) {
	if (units === 'metric') return { val: ((f - 32) * 5 / 9).toFixed(1), unit: '°C' };
	return { val: f.toFixed(1), unit: '°F' };
}

// ─── Helpers ──────────────────────────────────────────────────────────────────
function calcFillPct(t) {
	const total = (t.volume || 0) + (t.ullage || 0);
	if (total <= 0) return 0;
	return Math.min(100, Math.round((t.volume / total) * 100));
}

function fillColor(pct) {
	if (pct < 10) return '#ef4444';
	if (pct < 20) return '#f59e0b';
	return '#22c55e';
}

function shortTime(iso) {
	if (!iso) return '—';
	try {
		return new Date(iso).toLocaleTimeString('en-US', { hour12: false });
	} catch { return iso; }
}

function escHtml(str) {
	return String(str)
		.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
		.replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

// ─── Toast ────────────────────────────────────────────────────────────────────
function showToast(message, type = 'info') {
	const container = document.getElementById('toastContainer');
	const toast = document.createElement('div');
	toast.className = `toast ${type}`;
	toast.textContent = message;
	container.appendChild(toast);
	setTimeout(() => toast.remove(), 3500);
}
