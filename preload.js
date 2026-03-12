'use strict';

const { contextBridge, ipcRenderer } = require('electron');

// Safe, typed API exposed to the renderer (no raw ipcRenderer access)
contextBridge.exposeInMainWorld('tankAPI', {

	// ── Serial port ────────────────────────────────────────────────────────────
	listPorts: () => ipcRenderer.invoke('serial:list'),
	connect: config => ipcRenderer.invoke('serial:connect', config),
	disconnect: () => ipcRenderer.invoke('serial:disconnect'),
	send: payload => ipcRenderer.invoke('serial:send', payload),

	// ── Events from main → renderer ────────────────────────────────────────────
	onRawData: cb => ipcRenderer.on('serial:raw', (_e, v) => cb(v)),
	onOMNTECData: cb => ipcRenderer.on('omntec:data', (_e, v) => cb(v)),
	onSerialError: cb => ipcRenderer.on('serial:error', (_e, v) => cb(v)),
	onDisconnected: cb => ipcRenderer.on('serial:disconnected', (_e, v) => cb(v)),

	// Remove all listeners for a channel (cleanup on view switch)
	removeListeners: channel => ipcRenderer.removeAllListeners(channel),

	// ── Logs ───────────────────────────────────────────────────────────────────
	listLogs: () => ipcRenderer.invoke('logs:list'),
	readLog: filename => ipcRenderer.invoke('logs:read', filename),
	exportCSV: () => ipcRenderer.invoke('logs:export-csv'),
	openLogsFolder: () => ipcRenderer.invoke('logs:open-folder'),

	// ── Settings ───────────────────────────────────────────────────────────────
	loadSettings: () => ipcRenderer.invoke('settings:load'),
	saveSettings: (s) => ipcRenderer.invoke('settings:save', s),
});
