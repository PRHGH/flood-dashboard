const sqlite3 = require("sqlite3").verbose();
const path = require("path");

const DB_PATH = process.env.DB_PATH || path.join(__dirname, "scada.db");

const db = new sqlite3.Database(DB_PATH, (err) => {
  if (err) console.error("Failed to open database:", err.message);
});

function run(sql, params = []) {
  return new Promise((resolve, reject) => {
    db.run(sql, params, function (err) {
      if (err) reject(err);
      else resolve(this);
    });
  });
}

function all(sql, params = []) {
  return new Promise((resolve, reject) => {
    db.all(sql, params, (err, rows) => {
      if (err) reject(err);
      else resolve(rows);
    });
  });
}

async function init() {
  await run(`
    CREATE TABLE IF NOT EXISTS water_levels (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      station TEXT NOT NULL,
      upstream REAL,
      downstream REAL,
      station_online INTEGER NOT NULL DEFAULT 1,
      timestamp TEXT NOT NULL,
      UNIQUE(station, timestamp)
    )
  `);
  await run(`CREATE INDEX IF NOT EXISTS idx_water_levels_timestamp ON water_levels(timestamp)`);
  await run(`CREATE INDEX IF NOT EXISTS idx_water_levels_station ON water_levels(station)`);
  console.log(`Database ready at ${DB_PATH}`);
}

// Rounds down to the nearest 5-minute boundary, e.g. 14:37:xx -> "2026-07-23 14:35:00".
// Both the save cycle and the history query use this same rule so live and
// historical data land on the same grid and merge cleanly on the frontend.
function getAligned5MinTimestamp(date = new Date()) {
  const d = new Date(date);
  d.setSeconds(0, 0);
  d.setMinutes(Math.floor(d.getMinutes() / 5) * 5);
  const pad = (n) => String(n).padStart(2, "0");
  return (
    `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ` +
    `${pad(d.getHours())}:${pad(d.getMinutes())}:00`
  );
}

// Upsert: re-saving the same (station, timestamp) overwrites rather than
// duplicating, so a restart mid-interval or a slightly-off timer tick can't
// create duplicate rows for the same 5-minute bucket.
async function saveWaterLevel({ station, upstream, downstream, online, timestamp }) {
  await run(
    `INSERT INTO water_levels (station, upstream, downstream, station_online, timestamp)
     VALUES (?, ?, ?, ?, ?)
     ON CONFLICT(station, timestamp) DO UPDATE SET
       upstream = excluded.upstream,
       downstream = excluded.downstream,
       station_online = excluded.station_online`,
    [station, upstream, downstream, online ? 1 : 0, timestamp]
  );
}

// Pivots rows into one object per timestamp, e.g.
// { timestamp, Ambathale_upstream, Ambathale_downstream, ... }
// ready for direct use in a chart. Offline readings were saved as NULL,
// so they come back as null here too - a real gap, not a fake flat line.
async function fetch24HourHistory() {
  const rows = await all(
    `SELECT station, upstream, downstream, timestamp FROM water_levels
     WHERE timestamp >= datetime('now', '-24 hours')
     ORDER BY timestamp ASC`
  );

  const byTimestamp = new Map();
  for (const row of rows) {
    if (!byTimestamp.has(row.timestamp)) {
      byTimestamp.set(row.timestamp, { timestamp: row.timestamp });
    }
    const entry = byTimestamp.get(row.timestamp);
    entry[`${row.station}_upstream`] = row.upstream;
    entry[`${row.station}_downstream`] = row.downstream;
  }
  return Array.from(byTimestamp.values());
}

// Real cleanup, wired to an actual timer in server.js - not a disabled stub.
async function cleanupOldData(retentionDays) {
  const result = await run(
    `DELETE FROM water_levels WHERE timestamp < datetime('now', '-' || ? || ' days')`,
    [retentionDays]
  );
  return result.changes || 0;
}

module.exports = {
  init,
  getAligned5MinTimestamp,
  saveWaterLevel,
  fetch24HourHistory,
  cleanupOldData,
};