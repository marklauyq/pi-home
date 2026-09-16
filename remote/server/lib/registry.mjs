/**
 * Registry: devices, live sessions, history sessions, ring buffers.
 *
 * sessionKey = `${deviceId}~${sessionId}` for live sessions.
 * sessionKey = `${deviceId}~f~${basename(file)}` for historical sessions.
 */

import { writeFileSync, renameSync, unlinkSync, existsSync } from 'node:fs';
import { join } from 'node:path';

const MAX_RING_ITEMS = 200;

class RingBuffer {
  constructor(maxItems) {
    this.items = [];
    this.maxItems = maxItems;
  }

  push(item) {
    this.items.push(item);
    if (this.items.length > this.maxItems) {
      this.items.shift();
    }
  }

  getAll() {
    return [...this.items];
  }
}

/**
 * Main registry class.
 */
export class Registry {
  constructor() {
    // deviceId → device info
    this.devices = new Map();
    // sessionKey → { sessionId, deviceId, cwd, model, state, startedAt, ring }
    this.liveSessions = new Map();
    // sessionKey (historical) → { file, device, updatedAt, ... }
    this.historySessions = new Map();
  }

  /** Register or update a device. */
  setDevice(device) {
    this.devices.set(device.id, {
      ...device,
      connected: true,
      lastSeen: Date.now(),
    });
  }

  /** Mark device as disconnected. */
  unsetDevice(deviceId) {
    const d = this.devices.get(deviceId);
    if (d) {
      d.connected = false;
    }
  }

  /** Get all connected devices. */
  getConnectedDevices() {
    const result = [];
    for (const [, d] of this.devices) {
      if (d.connected) {
        result.push({ id: d.id, name: d.name, host: d.host });
      }
    }
    return result;
  }

  /** Get all devices (connected or not). */
  getAllDevices() {
    const result = [];
    for (const [, d] of this.devices) {
      result.push({ id: d.id, name: d.name, host: d.host, connected: d.connected });
    }
    return result;
  }

  /** Register a live session. */
  registerSession(sessionKey, info) {
    const ring = new RingBuffer(MAX_RING_ITEMS);
    this.liveSessions.set(sessionKey, {
      sessionId: info.sessionId,
      deviceId: info.deviceId,
      cwd: info.cwd,
      model: info.model,
      state: info.state ?? 'idle',
      startedAt: info.startedAt,
      ring,
    });
  }

  /** Unregister a live session. */
  unregisterSession(sessionKey) {
    this.liveSessions.delete(sessionKey);
  }

  /** Get a live session by key. */
  getLiveSession(sessionKey) {
    return this.liveSessions.get(sessionKey) ?? null;
  }

  /** Get device ID from session key. */
  getDeviceIdForSession(sessionKey) {
    const idx = sessionKey.indexOf('~');
    if (idx === -1) return null;
    return sessionKey.substring(0, idx);
  }

  /** Push an event into a live session's ring buffer. */
  pushEvent(sessionKey, item) {
    const s = this.liveSessions.get(sessionKey);
    if (s) {
      s.ring.push(item);
    }
  }

  /** Update session state. */
  updateSessionState(sessionKey, state) {
    const s = this.liveSessions.get(sessionKey);
    if (s) {
      s.state = state;
    }
  }

  /**
   * Mark all live sessions of a device as stopped (device fully offline).
   * A running session can't exist without its device, so clear any stale
   * "running" state to keep the UI honest. Re-registration restores the
   * true state when the device reconnects.
   */
  markDeviceSessionsStopped(deviceId) {
    for (const s of this.liveSessions.values()) {
      if (s.deviceId === deviceId && s.state === 'running') {
        s.state = 'stopped';
      }
    }
  }

  /** Register a historical session. */
  registerHistory(sessionKey, info) {
    this.historySessions.set(sessionKey, {
      file: info.file,
      device: info.device,
      updatedAt: info.updatedAt,
      lastUserText: info.lastUserText,
      model: info.model,
      cwd: info.cwd,
      messageCount: info.messageCount,
    });
  }

  /** Get all history sessions. */
  getAllHistory() {
    const result = [];
    for (const [key, h] of this.historySessions) {
      result.push({ sessionKey: key, ...h });
    }
    return result;
  }

  /** Remove a history session. */
  unregisterHistory(sessionKey) {
    this.historySessions.delete(sessionKey);
  }

  /**
   * Build the full ui.sessions payload.
   */
  buildSessionsPayload() {
    return {
      devices: this.getAllDevices(),
      live: Array.from(this.liveSessions.entries()).map(([sessionKey, s]) => ({
        sessionKey,
        sessionId: s.sessionId,
        device: s.deviceId,
        cwd: s.cwd,
        model: s.model,
        state: s.state,
        startedAt: s.startedAt,
      })),
      history: this.getAllHistory(),
    };
  }

  /**
   * Check if a device is connected.
   */
  isDeviceConnected(deviceId) {
    const d = this.devices.get(deviceId);
    return d !== undefined && d.connected;
  }

  /**
   * Get device info by ID.
   */
  getDevice(deviceId) {
    return this.devices.get(deviceId) ?? null;
  }

  /**
   * Persist devices.json snapshot (atomic write: tmp + renameSync).
   */
  persistDevices(stateDir) {
    const data = {};
    for (const [id, d] of this.devices) {
      data[id] = {
        id: d.id,
        name: d.name,
        host: d.host,
        platform: d.platform,
        cwd: d.cwd,
        connected: d.connected,
        lastSeen: d.lastSeen,
      };
    }
    const tmpPath = join(stateDir, 'devices.json.tmp');
    const destPath = join(stateDir, 'devices.json');
    try {
      writeFileSync(tmpPath, JSON.stringify(data, null, 2), 'utf-8');
      renameSync(tmpPath, destPath);
    } catch (e) {
      try { unlinkSync(tmpPath); } catch {}
      console.error(`persistDevices failed: ${e.message}`);
    }
  }
}