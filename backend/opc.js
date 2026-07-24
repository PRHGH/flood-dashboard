const { OPCUAClient, AttributeIds } = require("node-opcua");
const stations = require("./station");

const OPC_ENDPOINT = process.env.OPC_ENDPOINT || "opc.tcp://localhost:59100";
const READ_TIMEOUT_MS = Number(process.env.READ_TIMEOUT_MS || 3000);

let client = null;
let session = null;
let opcOnline = false;
let connecting = false;

// A timeout on its own isn't fatal - a station can genuinely be slow for
// one cycle and recover. But our timeout only makes OUR CODE stop waiting;
// it does NOT cancel the underlying request on the OPC UA channel. If a
// tag is truly stuck (permanently unanswered - e.g. a dead sensor, not
// just a slow one), that request sits on the shared session forever, and
// since a channel processes one request at a time, EVERY subsequent read -
// for any station, including perfectly healthy ones - queues up behind it
// and can never get a turn. That's what turns "one dead tag" into "every
// station times out, forever": the channel is jammed, not the stations.
//
// Detect that pattern (several timeouts stacking up back-to-back, roughly
// one full pass over the station list with none of them succeeding) and
// force a full reconnect - this discards the stuck request/session/channel
// and gets a fresh one, which is the only way to actually recover once
// this happens. A single successful read of any kind resets the counter,
// so this never fires just because one station is genuinely, individually
// down (that's handled separately, by the backoff logic in server.js).
let consecutiveTimeouts = 0;
const MAX_CONSECUTIVE_TIMEOUTS = Number(process.env.MAX_CONSECUTIVE_TIMEOUTS || 4);
let reconnecting = false;

function isConnectionClosedError(message = "") {
  return (
    message.includes("BadConnectionClosed") ||
    message.includes("Invalid Channel") ||
    message.includes("BadSessionClosed") ||
    message.includes("BadSecureChannelClosed") ||
    message.includes("Connection is closed") ||
    message.includes("Channel has been closed") ||
    message.includes("ECONNREFUSED") ||
    message.includes("Transaction has timed out")
  );
}

async function closeOPCUA() {
  const oldSession = session;
  const oldClient = client;
  session = null;
  client = null;
  opcOnline = false;
  try { if (oldSession) await oldSession.close(); } catch (_) {}
  try { if (oldClient) await oldClient.disconnect(); } catch (_) {}
}

async function connectOPCUA() {
  if (connecting) return opcOnline;
  connecting = true;
  try {
    await closeOPCUA();
    client = OPCUAClient.create({
      endpointMustExist: false,
      requestedSessionTimeout: 120000,
      defaultSecureTokenLifetime: 120000,
      connectionStrategy: { maxRetry: 0 },
    });

    console.log(`Connecting to OPC UA: ${OPC_ENDPOINT}`);
    await client.connect(OPC_ENDPOINT);
    session = await client.createSession();
    opcOnline = true;
    console.log("Connected to OPC UA server");
  } catch (err) {
    opcOnline = false;
    console.error("OPC UA connection failed:", err.message);
    await closeOPCUA();
  } finally {
    connecting = false;
  }
  return opcOnline;
}

function readWithTimeout(promise, ms, label) {
  promise.catch(() => {});
  return Promise.race([
    promise,
    new Promise((_, reject) =>
      setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms)
    ),
  ]);
}

async function readStationRaw(stationName) {
  const config = stations[stationName];
  if (!config) return {};

  if (!session || !opcOnline) return {};

  const entries = Object.entries(config).filter(
    ([, nodeId]) => typeof nodeId === "string" && nodeId.trim() !== ""
  );
  if (entries.length === 0) return {};

  try {
    const nodesToRead = entries.map(([, nodeId]) => ({
      nodeId: nodeId.trim(),
      attributeId: AttributeIds.Value,
    }));

    const results = await readWithTimeout(
      session.read(nodesToRead),
      READ_TIMEOUT_MS,
      `${stationName} read`
    );

    const values = {};
    entries.forEach(([key], index) => {
      const dataValue = results[index];
      const status = dataValue?.statusCode?.name || "Unknown";
      const value = dataValue?.value?.value ?? null;
      values[key] = { value, status, ok: status === "Good" && value !== null };
    });
    consecutiveTimeouts = 0; // any successful round-trip proves the channel is alive
    return values;
  } catch (err) {
    if (isConnectionClosedError(err.message || "")) {
      console.warn(`OPC channel issue during ${stationName} read: ${err.message}`);
      consecutiveTimeouts = 0;
      await closeOPCUA();
    } else {
      console.warn(`Batch read failed for ${stationName}: ${err.message}`);
      consecutiveTimeouts += 1;
      if (consecutiveTimeouts >= MAX_CONSECUTIVE_TIMEOUTS && !reconnecting) {
        reconnecting = true;
        console.warn(
          `${consecutiveTimeouts} read timeouts in a row - OPC UA channel looks jammed behind a stuck request, forcing reconnect`
        );
        consecutiveTimeouts = 0;
        try {
          await closeOPCUA();
        } finally {
          reconnecting = false;
        }
      }
    }
    return {};
  }
}

function isOnline() {
  return opcOnline;
}

function stationNames() {
  return Object.keys(stations);
}

module.exports = {
  connectOPCUA,
  closeOPCUA,
  readStationRaw,
  isOnline,
  stationNames,
};