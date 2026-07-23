"use client";

import { useState } from "react";
import { useScadaData } from "@/hooks/use-scada-data";
import { SectionErrorBoundary } from "@/components/error-boundary";
import { STATIONS_LIST } from "@/lib/types";

// Temporary - proves SectionErrorBoundary actually contains a crash instead
// of just assuming it does. Delete this component once verified (noted in
// the checkpoint instructions).
function CrashTest() {
  const [shouldCrash, setShouldCrash] = useState(false);
  if (shouldCrash) {
    throw new Error("Deliberate test crash");
  }
  return <button onClick={() => setShouldCrash(true)}>Click to test crash containment</button>;
}

export default function Home() {
  const { stations, opcOnline, lastUpdated, history, wsConnected, isLoadingHistory } =
    useScadaData();

  return (
    <main style={{ padding: 24, fontFamily: "sans-serif", display: "grid", gap: 16 }}>
      <SectionErrorBoundary label="Status">
        <div>
          <strong>OPC UA:</strong> {opcOnline ? "online" : "offline"} &nbsp;|&nbsp;
          <strong>WebSocket:</strong> {wsConnected ? "connected" : "disconnected"} &nbsp;|&nbsp;
          <strong>Last update:</strong> {lastUpdated ?? "—"}
        </div>
      </SectionErrorBoundary>

      <SectionErrorBoundary label="Crash Test">
        <CrashTest />
      </SectionErrorBoundary>

      <SectionErrorBoundary label="Quick Stats">
        <div>
          <h3>Quick Stats (placeholder — real component in Step 7)</h3>
          <pre>
            {STATIONS_LIST.map((name) => {
              const s = stations[name];
              return `${name}: up=${s?.upstream ?? "—"} down=${s?.downstream ?? "—"}\n`;
            })}
          </pre>
        </div>
      </SectionErrorBoundary>

      <SectionErrorBoundary label="Water Level Chart">
        <div>
          <h3>Water Level Chart (placeholder — real component in Step 8)</h3>
          <p>{isLoadingHistory ? "Loading history..." : `${history.length} history rows loaded`}</p>
        </div>
      </SectionErrorBoundary>

      {STATIONS_LIST.map((name) => {
        const data = stations[name];
        if (!data) return null;
        return (
          <SectionErrorBoundary key={name} label={name}>
            <div style={{ border: "1px solid #ddd", padding: 12, borderRadius: 8 }}>
              <h4>{name} (placeholder — real StationCard in Step 7)</h4>
              <pre>{JSON.stringify(data, null, 2)}</pre>
            </div>
          </SectionErrorBoundary>
        );
      })}
    </main>
  );
}