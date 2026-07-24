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

// ---------- per-station circuit breaker ----------
// OPC UA sessions/secure channels are effectively single-request-in-flight -
// this project already hit that once, as "invalid requestId" errors when
// overlapping broadcast ticks piled up concurrent reads on one session.
// Reading every station with Promise.all() on the shared `session` runs
// into the exact same wall: the channel still serializes them on the wire,
// but every read's timeout clock starts at the same instant, so anything
// queued behind another read blows past its own deadline before its turn
// even comes up - which is why a previously-fine station starts timing out
// too. Reads MUST stay sequential over one session.
//
// The actual problem to solve is different: a station that's genuinely
// down still costs a full READ_TIMEOUT_MS on EVERY cycle, and with two
// stations down that alone was ~16s/cycle before the loop even reached the
// healthy ones. The fix is a backoff - once a station has failed a couple
// of cycles in a row, stop actually attempting it every tick; serve its
// last-known (offline) result and only pay the timeout again once every
// STATION_BACKOFF_MS. Healthy stations are read every cycle as normal and
// are never affected by another station's backoff state.
const STATION_FAILURE_THRESHOLD = 2; // consecutive misses before backing off
const STATION_BACKOFF_MS = Number(process.env.STATION_BACKOFF_MS || 10000);
const stationState = {}; // name -> { failStreak, skipUntil, last }

function getStationState(name) {
  if (!stationState[name]) {
    stationState[name] = { failStreak: 0, skipUntil: 0, last: offlineStation() };
  }
  return stationState[name];
}

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

    // Sequential, one station at a time - required, since concurrent reads
    // on one OPC UA session don't actually parallelize (see note above) and
    // instead make every station's read miss its own deadline. A station
    // that's currently backed off (see stationState) is skipped entirely
    // this cycle instead of being read - that's what keeps a persistently
    // down station from costing a full timeout on every single tick.
    const payload = { opcOnline: true, lastUpdated: new Date().toISOString(), stations: {} };
    const now = Date.now();
    for (const name of opc.stationNames()) {
      const state = getStationState(name);

      if (now < state.skipUntil) {
        // Still backed off from recent failures - reuse last-known result
        // without touching OPC UA this cycle. Frees up the loop for
        // healthy stations instead of blocking on a station we already
        // know is down.
        payload.stations[name] = state.last;
        continue;
      }

      let interpreted;
      try {
        const raw = await opc.readStationRaw(name);
        interpreted = interpretStation(name, raw);
      } catch (err) {
        // One station failing to interpret never blocks the others.
        console.error(`${name}: interpret failed - ${err.message}`);
        interpreted = offlineStation();
      }

      payload.stations[name] = interpreted;
      state.last = interpreted;

      if (interpreted.stationOnline) {
        state.failStreak = 0;
        state.skipUntil = 0;
      } else {
        state.failStreak += 1;
        if (state.failStreak >= STATION_FAILURE_THRESHOLD) {
          state.skipUntil = now + STATION_BACKOFF_MS;
        }
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
    if (!opc.isOnline() || !lastPayload) return;

    // Reuse the most recent broadcastCycle payload instead of firing a
    // second, independent set of OPC reads here. Previously saveCycle
    // called opc.readStationRaw() itself on the same shared `session` -
    // that's concurrent traffic on one OPC UA channel, landing right when
    // broadcastCycle may already be mid-read (e.g. stuck on a down
    // station's timeout), which is a plausible source of the "everything
    // blips near the 5-minute mark" pattern. Reading once and saving what
    // was already fetched also guarantees the saved row matches exactly
    // what was shown on screen at that moment.
    const timestamp = db.getAligned5MinTimestamp();
    for (const name of opc.stationNames()) {
      if (!hasWaterLevel(name)) continue;
      const st = lastPayload.stations[name];
      if (!st) continue;
      try {
        await db.saveWaterLevel({
          station: name,
          upstream: st.upstream,
          downstream: st.downstream,
          online: st.stationOnline,
          timestamp,
        });
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

  // CRITICAL: without this, a client-side network blip (WiFi drop, tab
  // close, sleep/wake, router hiccup - all ordinary, unavoidable events)
  // emits an 'error' event on this socket. An EventEmitter's 'error' event
  // with no listener throws an UNCAUGHT EXCEPTION THAT CRASHES THE ENTIRE
  // NODE PROCESS. This was the actual cause of "works for a while, then
  // crashes" - not the OPC UA timeouts we were chasing.
  ws.on("error", (err) => {
    console.error("WebSocket client error:", err.message);
  });

  ws.on("close", () => console.log("Client disconnected"));
});

wss.on("error", (err) => {
  console.error("WebSocket server error:", err.message);
});

// Last-resort safety net: log and keep running instead of crashing the
// whole backend on any error we didn't anticipate. For this application,
// staying online (even having logged something odd) is more valuable than
// dying cleanly - an offline flood monitoring system helps no one.
process.on("uncaughtException", (err) => {
  console.error("Uncaught exception (backend kept running):", err);
});

process.on("unhandledRejection", (reason) => {
  console.error("Unhandled promise rejection (backend kept running):", reason);
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