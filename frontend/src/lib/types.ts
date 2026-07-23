export type GateStatus = "OPEN" | "CLOSE" | "INTERMEDIATE" | "UNKNOWN";

export interface StationPayload {
    stationOnline: boolean;
    upstream: number | null;
    downstream: number | null;
    gates: Record<string, GateStatus>;
    pumps: Record<string, boolean | null>;
}

export interface LivePayload {
    opcOnline: boolean;
    lastUpdates: string;
    stations: Record<string, StationPayload>;
}

export interface HistoryRow {
    timestamp: string;
    [key: string]: string | number | null;
}

export const STATIONS_LIST = [
  "Ambathale",
  "Gothatuwa",
  "Kalupaalama",
  "NorthLock",
  "SouthLock",
  "Thalangama",
] as const;

export type StationName = (typeof STATIONS_LIST)[number];