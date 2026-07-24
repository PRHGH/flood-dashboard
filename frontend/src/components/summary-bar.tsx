import { StationPayload, STATIONS_LIST } from "@/lib/types";

export function SummaryBar({
  stations,
  opcOnline,
  wsConnected,
  lastUpdated,
}: {
  stations: Record<string, StationPayload>;
  opcOnline: boolean;
  wsConnected: boolean;
  lastUpdated: string | null;
}) {
  const onlineCount = STATIONS_LIST.filter((name) => stations[name]?.stationOnline).length;

  const formattedTime = lastUpdated
    ? new Date(lastUpdated).toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit", second: "2-digit" })
    : "—";

  const connectionOk = opcOnline && wsConnected;

  return (
    <div
      style={{
        display: "flex",
        alignItems: "center",
        justifyContent: "space-between",
        flexWrap: "wrap",
        gap: 12,
        padding: "12px 16px",
        borderRadius: 12,
        background: "#0f172a",
        color: "#e2e8f0",
        fontFamily: "system-ui, sans-serif",
        fontSize: 13,
      }}
    >
      <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
        <span
          style={{
            width: 10,
            height: 10,
            borderRadius: "50%",
            background: connectionOk ? "#22c55e" : "#ef4444",
          }}
        />
        <strong>{connectionOk ? "System online" : "Connection issue"}</strong>
      </div>

      <div>
        {onlineCount} / {STATIONS_LIST.length} stations online
      </div>

      <div style={{ color: "#94a3b8" }}>
        Last update: <span style={{ fontFamily: "ui-monospace, monospace" }}>{formattedTime}</span>
      </div>
    </div>
  );
}