import { GateStatus, StationPayload } from "./types";

const VALID_GATE_STATUSES: readonly GateStatus[] = ["OPEN", "CLOSE", "INTERMEDIATE", "UNKNOWN" ];

export function safeNumber(v: unknown): number | null {
    return typeof v === "number" && Number.isFinite(v) ? v : null;
}

function safeBoolOrNull(v: unknown): boolean | null {
    return typeof v === "boolean" ? v : null;
}

function safeGateStatus(v: unknown): GateStatus {
  return typeof v === "string" && (VALID_GATE_STATUSES as readonly string[]).includes(v)
    ? (v as GateStatus)
    : "UNKNOWN";
}

export function offlineStation(): StationPayload {
  return { stationOnline: false, upstream: null, downstream: null, gates: {}, pumps: {} };
}

/*
  Turns an arbitrary/untrusted incoming station object into a guaranteed-safe
  StationPayload. Every field either matches its expected type or falls back
  to a safe "unknown" value. This is the ONE place that ever needs to worry
  about a wrong-type or malformed value from the network - nothing
  downstream (hooks, components) needs its own type guards after this.
*/
export function sanitizeStation(raw: unknown): StationPayload {
  const r = (raw ?? {}) as Record<string, unknown>;
 
  const gatesRaw = (r.gates ?? {}) as Record<string, unknown>;
  const gates: Record<string, GateStatus> = {};
  for (const [key, value] of Object.entries(gatesRaw)) {
    gates[key] = safeGateStatus(value);
  }
 
  const pumpsRaw = (r.pumps ?? {}) as Record<string, unknown>;
  const pumps: Record<string, boolean | null> = {};
  for (const [key, value] of Object.entries(pumpsRaw)) {
    pumps[key] = safeBoolOrNull(value);
  }
 
  return {
    stationOnline: typeof r.stationOnline === "boolean" ? r.stationOnline : false,
    upstream: safeNumber(r.upstream),
    downstream: safeNumber(r.downstream),
    gates,
    pumps,
  };
}

