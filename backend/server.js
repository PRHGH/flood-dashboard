const opc = require("./opc");

const SCAN_INTERVAL_MS = Number(proces.env.SCAN_INTERVAL_MS || 1000);

let scanning = false;

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
}

(async () => {
    await opc.connectOPCUA();
    await scanOnce();
    setInterval(scaneOnce, SCAN_INTERVAL_MS);
}) ();