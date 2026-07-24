const { OPCUAClient, AttributeIds } = require("node-opcua");
const stations = require("./station");

const OPC_ENDPOINT = process.env.OPC_ENDPOINT || "opc.tcp://localhost:59100";
const READ_TIMEOUT_MS = Number(process.env.READ_TIMEOUT_MS || 3000);

let client = null;
let session = null;
let opcOnline = false;
let connecting = false;

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
      // NOTE: deliberately NOT setting defaultTransactionTimeout here.
      // That option applies to every message the client sends, including
      // the internal GetEndpoints/CreateSession handshake performed by
      // connect()/createSession() - setting it too short (e.g. 3s) can
      // abort the handshake itself and leave node-opcua's internal
      // request bookkeeping in a bad state ("Investigate me" /
      // "request has already been set with a requestHandle" errors).
      // The fast timeout we actually want only applies to the repeated
      // per-station tag reads, enforced below via readWithTimeout().
      //
      // Our own scan loop already retries every SCAN_INTERVAL_MS, so we
      // disable node-opcua's internal connection retry (maxRetry: 0) to
      // avoid its retry loop and ours compounding into overlapping
      // handshake attempts.
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
  // If we time out before `promise` settles, it may still resolve/reject
  // later in the background with nothing listening - swallow that so it
  // doesn't surface as an unhandled rejection.
  promise.catch(() => {});
  return Promise.race([
    promise,
    new Promise((_, reject) =>
      setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms)
    ),
  ]);
}

/*
  Reads every tag for one station in a single batched request.
  Never throws: a failed session, a failed batch read, or an
  individual bad value all resolve to safe fallbacks so the
  caller never needs its own try/catch around this.
*/
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
    return values;
  } catch (err) {
    if (isConnectionClosedError(err.message || "")) {
      console.warn(`OPC channel issue during ${stationName} read: ${err.message}`);
      await closeOPCUA();
    } else {
      console.warn(`Batch read failed for ${stationName}: ${err.message}`);
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