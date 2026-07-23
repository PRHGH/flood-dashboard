require("dotenv").config();
const express = require("express");
const cors = require("cors");
const http = require("http");
const WebSocket = require("ws");

const opc = require("./opc");
const db = require("./database");
const stations = require("./station");

const PORT = Number(process.env.PORT || 8081);
const API_KEY = process.env.API_KEY || "";
const SCAN_INTERVAL_MS = Number(process.env.SCAN_INTERVAL_MS || 1000);
const SAVE_INTERVAL_MS = Number(process.env.SAVE_INTERVAL_MS || 5 * 60 * 1000);
const CLEANUP_INTERVAL_MS = Number(process.env.CLEANUP_INTERVAL_MS || 60 * 60 * 1000);
const RETENTION_DAYS = Number(process.env.RETENTION_DAYS || 30);

let scanning = false;
let saving = false;
let lastPayload = null;

// ---------- value interpretation ----------
// Raw tag values -> the shape the frontend actually renders. Kept in
// server.js (not opc.js) since this is business logic about what a gate's
// three sensors mean, not about talking to OPC UA.

function safeNumber(v) {
  return typeof v === "number" && Number.isFinite(v) ? v : null;
}

// Some sensors (observed on Ambathale) report raw centimeters instead of
// meters. A real flood-station water level is never above ~20m, so any
// value bigger than that is almost certainly centimeters - convert it.
function normalizeLevel(v) {
  if (v === null) return null;
  return v > 20 ? v / 100 : v;
}

function extractLevel(raw, key) {
  const entry = raw[key];
  if (!entry || !entry.ok) return null;
  return normalizeLevel(safeNumber(entry.value));
}

function getGateNumbers(config) {
  const nums = new Set();
  for (const key of Object.keys(config)) {
    const m = key.match(/Gate(\d+)/i);
    if (m) nums.add(m[1]);
  }
  return [...nums].sort((a, b) => Number(a) - Number(b));
}

// Every station names its "third" gate signal differently
// (Gate1_intermediate / fault_Gate1 / Fault_Gate1 / upper_limit_Gate1) -
// find it by pattern instead of hardcoding a name per station.
function findThirdSignalKey(config, n) {
  return Object.keys(config).find((k) => {
    if (!new RegExp(`Gate${n}(_|$)`, "i").test(k)) return false;
    return !/fully_open|fully_close/i.test(k);
  });
}

// Tri-state by design: "UNKNOWN" when we can't confirm a position, never
// guessed as OPEN/CLOSE - an operator seeing "UNKNOWN" should check the
// gate in person rather than trust a silent default.
function gateStatus(raw, config, n) {
  const open = raw[`Gate${n}_fully_open`];
  const close = raw[`Gate${n}_fully_close`];
  const thirdKey = findThirdSignalKey(config, n);
  const third = thirdKey ? raw[thirdKey] : null;

  const isOpen = open?.ok ? Boolean(open.value) : null;
  const isClosed = close?.ok ? Boolean(close.value) : null;
  const isThird = third?.ok ? Boolean(third.value) : null;

  if (isOpen === null && isClosed === null && isThird === null) return "UNKNOWN";
  if (isOpen) return "OPEN";
  if (isClosed) return "CLOSE";
  if (isThird) return "INTERMEDIATE";
  return "UNKNOWN";
}

function getPumpKeys(config) {
  return Object.keys(config).filter((k) => /^Pump\d+$/i.test(k));
}

// true/false/null - null means "couldn't read it", distinct from a
// confirmed-off pump. Never collapse an unknown pump state to false.
function pumpState(raw, key) {
  const entry = raw[key];
  return entry?.ok ? Boolean(entry.value) : null;
}

function hasWaterLevel(name) {
  return Boolean(stations[name]?.UpStream);
}

function offlineStation() {
  return { stationOnline: false, upstream: null, downstream: null, gates: {}, pumps: {} };
}

function interpretStation(name, raw) {
  const config = stations[name];
  const validCount = Object.values(raw).filter((v) => v.ok).length;
  const stationOnline = validCount > 0;

  const gates = {};
  for (const n of getGateNumbers(config)) {
    gates[`Gate${n}`] = gateStatus(raw, config, n);
  }

  const pumps = {};
  for (const key of getPumpKeys(config)) {
    pumps[key] = pumpState(raw, key);
  }

  return {
    stationOnline,
    upstream: extractLevel(raw, "UpStream"),
    downstream: extractLevel(raw, "DownStream"),
    gates,
    pumps,
  };
}

function buildOfflinePayload() {
  const stationsObj = {};
  for (const name of opc.stationNames()) stationsObj[name] = offlineStation();
  return { opcOnline: false, lastUpdated: new Date().toISOString(), stations: stationsObj };
}

// ---------- broadcast cycle (1s) ----------

async function broadcastCycle() {
  if (scanning) return;
  scanning = true;
  try {
    if (!opc.isOnline()) {
      await opc.connectOPCUA();
      if (!opc.isOnline()) {
        lastPayload = buildOfflinePayload();
        broadcastToClients(lastPayload);
        return;
      }
    }

    const payload = { opcOnline: true, lastUpdated: new Date().toISOString(), stations: {} };
    for (const name of opc.stationNames()) {
      try {
        const raw = await opc.readStationRaw(name);
        payload.stations[name] = interpretStation(name, raw);
      } catch (err) {
        // One station failing to interpret never blocks the others.
        console.error(`${name}: interpret failed - ${err.message}`);
        payload.stations[name] = offlineStation();
      }
    }
    lastPayload = payload;
    broadcastToClients(payload);
  } finally {
    scanning = false;
  }
}

function broadcastToClients(payload) {
  const json = JSON.stringify(payload);
  wss.clients.forEach((ws) => {
    if (ws.readyState === WebSocket.OPEN) ws.send(json);
  });
}

// ---------- save cycle (5min) ----------

async function saveCycle() {
  if (saving) return;
  saving = true;
  try {
    if (!opc.isOnline()) return;

    const timestamp = db.getAligned5MinTimestamp();
    for (const name of opc.stationNames()) {
      if (!hasWaterLevel(name)) continue;
      try {
        const raw = await opc.readStationRaw(name);
        const validCount = Object.values(raw).filter((v) => v.ok).length;
        const online = validCount > 0;
        const upstream = extractLevel(raw, "UpStream");
        const downstream = extractLevel(raw, "DownStream");
        await db.saveWaterLevel({ station: name, upstream, downstream, online, timestamp });
      } catch (err) {
        console.error(`Failed to save ${name}: ${err.message}`);
      }
    }
  } finally {
    saving = false;
  }
}

async function cleanupCycle() {
  try {
    const deleted = await db.cleanupOldData(RETENTION_DAYS);
    if (deleted > 0) {
      console.log(`Cleanup: removed ${deleted} row(s) older than ${RETENTION_DAYS} days`);
    }
  } catch (err) {
    console.error("Cleanup failed:", err.message);
  }
}

// ---------- HTTP + WebSocket server ----------

const app = express();
app.use(cors());
app.use(express.json());

function requireApiKey(req, res, next) {
  if (!API_KEY) return next(); // no key configured - allow (local dev)
  if (req.headers["x-api-key"] === API_KEY) return next();
  res.status(401).json({ error: "Unauthorized" });
}

app.get("/stations", requireApiKey, (req, res) => {
  res.json(lastPayload || buildOfflinePayload());
});

app.get("/server-status", requireApiKey, (req, res) => {
  res.json({ opcOnline: opc.isOnline(), lastUpdated: lastPayload?.lastUpdated || null });
});

app.get("/history-24h", requireApiKey, async (req, res) => {
  try {
    const rows = await db.fetch24HourHistory();
    res.json(rows);
  } catch (err) {
    console.error("history-24h failed:", err.message);
    res.status(500).json({ error: "Failed to fetch history" });
  }
});

const server = http.createServer(app);

const wss = new WebSocket.Server({
  server,
  verifyClient(info, cb) {
    if (!API_KEY) return cb(true);
    const url = new URL(info.req.url, "http://localhost");
    const key = url.searchParams.get("apiKey") || info.req.headers["x-api-key"];
    if (key === API_KEY) cb(true);
    else cb(false, 401, "Unauthorized");
  },
});

wss.on("connection", (ws) => {
  console.log("Client connected");
  if (lastPayload) ws.send(JSON.stringify(lastPayload)); // new client sees current state immediately
  ws.on("close", () => console.log("Client disconnected"));
});

(async () => {
  await db.init();
  await opc.connectOPCUA();

  await broadcastCycle();
  setInterval(broadcastCycle, SCAN_INTERVAL_MS);

  await saveCycle();
  setInterval(saveCycle, SAVE_INTERVAL_MS);

  await cleanupCycle();
  setInterval(cleanupCycle, CLEANUP_INTERVAL_MS);

  server.listen(PORT, () => {
    console.log(`API running at http://localhost:${PORT}`);
    console.log(`WebSocket running at ws://localhost:${PORT}`);
  });
})();