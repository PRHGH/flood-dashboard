import { StationPayload, GateStatus } from "@/lib/types";

const GATE_COLOR: Record<GateStatus, string> = {
  OPEN: "#22c55e",
  CLOSE: "#64748b",
  INTERMEDIATE: "#f59e0b",
  UNKNOWN: "#94a3b8",
};

const GATE_LABEL: Record<GateStatus, string> = {
  OPEN: "Open",
  CLOSE: "Closed",
  INTERMEDIATE: "Intermediate",
  UNKNOWN: "Unknown",
};

function formatLevel(v: number | null): string {
  return v === null ? "—" : `${v.toFixed(2)} m MSL`;
}

function Pill({ color, label }: { color: string; label: string }) {
  return (
    <span
      style={{
        display: "inline-flex",
        alignItems: "center",
        gap: 6,
        fontSize: 12,
        fontFamily: "system-ui, sans-serif",
        color: "#1e293b",
        background: "#f1f5f9",
        borderRadius: 999,
        padding: "3px 10px",
        border: "1px solid #e2e8f0",
      }}
    >
      <span
        style={{
          width: 8,
          height: 8,
          borderRadius: "50%",
          background: color,
          flexShrink: 0,
        }}
      />
      {label}
    </span>
  );
}

export function StationCard({ name, data }: { name: string; data: StationPayload }) {
  const gateEntries = Object.entries(data.gates);
  const pumpEntries = Object.entries(data.pumps);
  const hasLevelData = data.upstream !== null || data.downstream !== null;

  return (
    <div
      style={{
        border: "1px solid #e2e8f0",
        borderRadius: 12,
        padding: 16,
        background: "#ffffff",
        display: "grid",
        gap: 12,
      }}
    >
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline" }}>
        <h3 style={{ margin: 0, fontFamily: "system-ui, sans-serif", fontSize: 16 }}>{name}</h3>
        <span
          style={{
            fontSize: 12,
            fontFamily: "system-ui, sans-serif",
            color: data.stationOnline ? "#166534" : "#991b1b",
            display: "flex",
            alignItems: "center",
            gap: 6,
          }}
        >
          <span
            style={{
              width: 8,
              height: 8,
              borderRadius: "50%",
              background: data.stationOnline ? "#22c55e" : "#ef4444",
            }}
          />
          {data.stationOnline ? "Online" : "Offline"}
        </span>
      </div>

      {hasLevelData && (
        <div
          style={{
            display: "flex",
            gap: 24,
            fontFamily: "ui-monospace, monospace",
            fontSize: 20,
          }}
        >
          <div>
            <div style={{ fontSize: 11, color: "#64748b", fontFamily: "system-ui, sans-serif" }}>
              Upstream
            </div>
            {formatLevel(data.upstream)}
          </div>
          <div>
            <div style={{ fontSize: 11, color: "#64748b", fontFamily: "system-ui, sans-serif" }}>
              Downstream
            </div>
            {formatLevel(data.downstream)}
          </div>
        </div>
      )}

      {gateEntries.length > 0 && (
        <div style={{ display: "flex", flexWrap: "wrap", gap: 6 }}>
          {gateEntries.map(([gateName, status]) => (
            <Pill key={gateName} color={GATE_COLOR[status]} label={`${gateName}: ${GATE_LABEL[status]}`} />
          ))}
        </div>
      )}

      {pumpEntries.length > 0 && (
        <div style={{ display: "flex", flexWrap: "wrap", gap: 6 }}>
          {pumpEntries.map(([pumpName, on]) => (
            <Pill
              key={pumpName}
              color={on === null ? "#94a3b8" : on ? "#22c55e" : "#64748b"}
              label={`${pumpName}: ${on === null ? "Unknown" : on ? "Running" : "Off"}`}
            />
          ))}
        </div>
      )}
    </div>
  );
}