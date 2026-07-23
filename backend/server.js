const opc = require("./opc");
const db = require("./database");
const stations = require("./station");

const SCAN_INTERVAL_MS = Number(process.env.SCAN_INTERVAL_MS || 1000);
const SAVE_INTERVAL_MS = Number(process.env.SAVE_INTERVAL_MS || 5 * 60 * 1000);
const CLEANUP_INTERVAL_MS = Number(process.env.CLEANUP_INTERVAL_MS || 60 * 60 * 1000);
const RETENTION_DAYS = Number(process.env.RETENTION_DAYS || 30);


let scanning = false;
let saving = false;

function safeNumber(v) {
  return typeof v === "number" && Number.isFinite(v) ? v : null;
}

function extractLevel(raw, key) {
  const entry = raw[key];
  if (!entry || !entry.ok) return null;
  return safeNumber(entry.value);
}

// Only the stations whose station.js config actually defines an UpStream
// tag have a water level to persist - Gothatuwa/Thalangama are gates-only.
function hasWaterLevel(name) {
  return Boolean(stations[name]?.UpStream);
}


async function scanOnce() {
  // Re-entrancy guard: if the previous scan is still running (e.g. a slow
  // or stuck OPC UA server), skip this tick rather than starting a second
  // overlapping scan on top of it.
    if (scanning) return;
    scanning = true;
    
    try {
        if (!opc.isOnline()) {
            await opc.connectOPCUA();
            if (!opc.isOnline()) {
                console.log("OPC UA offline - will retry next scan");
                return;
            }
        }
        for (const name of opc.stationNames()) {
            try {
                const values = await opc.readStationRaw(name);
                const validCount = Object.values(values).filter((v) => v.ok).length;
                const totalCount = Object.keys(values).length;
                console.log(`${name}: ${validCount}/${totalCount} tags OK`);
            }
            catch (err) {
                // Per-station isolation: one station throwing never stops the
                // others in this loop from being read and logged.
                console.error(`${name}: read failed - ${err.message}`);
            }
        }        
    }
    finally {
        scanning = false;
    }

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
                    console.log(`Saved ${name} @ ${timestamp}: up=${upstream} down=${downstream} online=${online}`);
                } catch (err) {
                    // One station failing to save never blocks the others in this loop.
                    console.error(`Failed to save ${name}: ${err.message}`);
                }
            }
        } finally {
            saving = false;
        }
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


(async () => {
    await db.init();
    await opc.connectOPCUA();

    await scanOnce();
    setInterval(scanOnce, SCAN_INTERVAL_MS);

    await saveCycle();
    setInterval(saveCycle, SAVE_INTERVAL_MS);
 
    await cleanupCycle();
    setInterval(cleanupCycle, CLEANUP_INTERVAL_MS);

}) ();