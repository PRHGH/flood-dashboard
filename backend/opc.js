const { OPCUAClient, AttributeIds, DataValue } = require("node-opcua");
const stations = require("./station");

const OPC_ENDPOINT = process.env.OPC_ENDPOINT || "opc.tcp://localhost:59100"; 
const READ_TIMEOUT_MS = Number(process.env.READ_TIMEOUT_MS || 3000);

let client = null;
let session = null;
let opcOnline = false;
let connecting = false;

function isConnectionClosedError(message = "") {
    return (
        message.includes("BadConnectionclosed") ||
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

    try { if (oldSession) await oldSession.close(); } catch (err) {}
    try { if (oldClient) await oldClient.disconnect(); } catch (err) {}
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
        // Kept short deliberately: with a 1s broadcast cadence, a tag that
        // hasn't answered in a couple of seconds won't answer in time to be
        // useful anyway. A long timeout here just delays detecting failure.
        defaultTransactionTimeout: READ_TIMEOUT_MS,
        connectionStrategy: { maxRetry: 5, initialDelay: 1000, maxDelay: 5000 },
        });

        console.log(`Connecting to OPC UA: ${OPC_ENDPOINT}`)
        await client.connect(OPC_ENDPOINT);
        session = await client.createSession();
        opcOnline = true;
        console.log("Connected to OPC UA server");
    }
    catch (err) {
        opcOnline = false;
        console.error("OPC UA connection failed: ", err.message);
        await closeOPCUA();
    }
    finally {
        connecting = false;
    }
    return opcOnline;
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
            attributeId:  AttributeIds. Value
        }));

        const results = await session.read(nodesToRead);

        const values = {};
        entries.forEach(([key], index) => {
            const dataValue = results[index];
            const status = dataValue.value?.statusCode?.name || "Unknown";
            const value = dataValue.value?.value ?? null;
            values[key] = { value, status, ok: status === "Good" && value !== null };
        });

        return values;
    }
    catch (err) {
        if (isConnectionClosedError(err.message || "")) {
            console.warn(`OPC channel issue during ${stationName} read: ${err.message}`);
            await closeOPCUA();
        }
        else {
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
