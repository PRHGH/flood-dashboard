"use client";
 
import { useEffect, useRef, useState } from "react";
import { STATIONS_LIST, StationPayload, HistoryRow } from "@/lib/types";
import { sanitizeStation, offlineStation } from "@/lib/sanitize";
 
const BACKEND_URL = process.env.NEXT_PUBLIC_BACKEND_URL || "http://localhost:8081";
const API_KEY = process.env.NEXT_PUBLIC_API_KEY || "";
const RECONNECT_DELAY_MS = 5000;

// How many consecutive "offline" readings a station must post before the
// UI actually shows the offline badge. A single missed OPC read cycle is
// normal, expected behavior (network jitter, a slow PLC tag, etc.) - it's
// not the same thing as a station actually being down, and flashing the
// badge on every one-tick blip trains operators to ignore it. A station
// that's genuinely down (e.g. a real outage) still crosses this threshold
// almost immediately, since it misses every cycle, not just one.
const OFFLINE_THRESHOLD = 3;

function toWsUrl(httpUrl: string): string {
    const url = new URL(httpUrl);
    url.protocol = url.protocol === "https:" ? "wss:" : "ws";
    if (API_KEY) url.searchParams.set("apiKey", API_KEY);
    return url.toString();
}

function emptyStations(): Record<string, StationPayload> {
  const result: Record<string, StationPayload> = {};
  for (const name of STATIONS_LIST) result[name] = offlineStation();
  return result;
}


export function useScadaData() {
  const [stations, setStations] = useState<Record<string, StationPayload>>(emptyStations());
  const [opcOnline, setOpcOnline] = useState(false);
  const [lastUpdated, setLastUpdated] = useState<string | null>(null);
  const [history, setHistory] = useState<HistoryRow[]>([]);
  const [wsConnected, setWsConnected] = useState(false);
  const [isLoadingHistory, setIsLoadingHistory] = useState(true);
 
  const wsRef = useRef<WebSocket | null>(null);
  const reconnectTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Tracks consecutive offline readings per station, purely for the
  // debounce below. Not exposed - the raw per-message truth still flows
  // into `next` every time; only what gets *rendered* is smoothed.
  const offlineStreakRef = useRef<Record<string, number>>({});
  // Mirrors the latest `stations` state so onmessage can read "what was
  // last shown" without depending on `stations` in the effect's closure
  // (which would force the WebSocket effect to re-run on every update).
  const displayedRef = useRef<Record<string, StationPayload>>(emptyStations());
 
  // One-time 24h history load, independent of the live WebSocket feed.
  useEffect(() => {
    let cancelled = false;
 
    (async () => {
      try {
        const res = await fetch(`${BACKEND_URL}/history-24h`, {
          headers: API_KEY ? { "x-api-key": API_KEY } : {},
        });
        if (!res.ok) throw new Error(`history-24h returned ${res.status}`);
        const rows: HistoryRow[] = await res.json();
        if (!cancelled) {
          console.log("[HISTORY]", rows.length, "rows loaded");
          setHistory(rows);
        }
      } catch (err) {
        console.error("Failed to load 24h history:", err);
      } finally {
        if (!cancelled) setIsLoadingHistory(false);
      }
    })();
 
    return () => {
      cancelled = true;
    };
  }, []);
 
  // Live WebSocket feed, with manual reconnect (browsers don't auto-reconnect).
  useEffect(() => {
    let stopped = false;
 
    function connect() {
      const ws = new WebSocket(toWsUrl(BACKEND_URL));
      wsRef.current = ws;
 
      ws.onopen = () => {
        console.log("[WS] connected");
        setWsConnected(true);
      };
 
      ws.onmessage = (event) => {
        let data: unknown;
        try {
          data = JSON.parse(event.data);
        } catch (err) {
          console.error("[WS] failed to parse message:", err);
          return;
        }
 
        console.log("[WS RAW]", new Date().toISOString(), data);
 
        const payload = (data ?? {}) as Record<string, unknown>;
        setOpcOnline(Boolean(payload.opcOnline));
        setLastUpdated(typeof payload.lastUpdated === "string" ? payload.lastUpdated : null);
 
        const incoming = (payload.stations ?? {}) as Record<string, unknown>;
 
        // Every station gets a value this cycle - sanitized if present,
        // explicitly offline if missing - never silently omitted. This is
        // the raw, honest truth for this cycle; it's what gets logged/used
        // for the streak count below, independent of what's displayed.
        const next: Record<string, StationPayload> = {};
        for (const name of STATIONS_LIST) {
          next[name] = name in incoming ? sanitizeStation(incoming[name]) : offlineStation();
        }

        // Debounce the OFFLINE badge only. A station coming back online
        // is reflected immediately (no reason to delay good news); a
        // station going offline only replaces what's displayed once it's
        // missed OFFLINE_THRESHOLD consecutive cycles in a row, so one
        // transient blip doesn't visibly flicker the UI.
        const streak = offlineStreakRef.current;
        const displayed: Record<string, StationPayload> = {};
        for (const name of STATIONS_LIST) {
          const st = next[name];
          if (st.stationOnline) {
            streak[name] = 0;
            displayed[name] = st;
          } else {
            streak[name] = (streak[name] ?? 0) + 1;
            displayed[name] =
              streak[name] >= OFFLINE_THRESHOLD
                ? st
                : displayedRef.current[name] ?? st;
          }
        }
        displayedRef.current = { ...displayedRef.current, ...displayed };
 
        // Merge, never replace - protects against any future message that
        // might not cover every station for some unforeseen reason.
        setStations((prev) => ({ ...prev, ...displayed }));
      };
 
      ws.onclose = () => {
        setWsConnected(false);
        if (!stopped) {
          reconnectTimer.current = setTimeout(connect, RECONNECT_DELAY_MS);
        }
      };
 
      ws.onerror = (err) => {
        console.error("[WS] error:", err);
      };
    }
 
    connect();
 
    return () => {
      stopped = true;
      if (reconnectTimer.current) clearTimeout(reconnectTimer.current);
      wsRef.current?.close();
    };
  }, []);
 
  return { stations, opcOnline, lastUpdated, history, wsConnected, isLoadingHistory };
}