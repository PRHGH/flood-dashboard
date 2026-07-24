"use client";

import { useScadaData } from "@/hooks/use-scada-data";
import { SectionErrorBoundary } from "@/components/error-boundary";
import { StationCard } from "@/components/station-card";
import { SummaryBar } from "@/components/summary-bar";
import { STATIONS_LIST } from "@/lib/types";

export default function Home() {
  const { stations, opcOnline, lastUpdated, history, wsConnected, isLoadingHistory } =
    useScadaData();

  return (
    <main
      style={{
        padding: 24,
        display: "grid",
        gap: 16,
        maxWidth: 960,
        margin: "0 auto",
        fontFamily: "system-ui, sans-serif",
      }}
    >
      <SectionErrorBoundary label="Summary">
        <SummaryBar
          stations={stations}
          opcOnline={opcOnline}
          wsConnected={wsConnected}
          lastUpdated={lastUpdated}
        />
      </SectionErrorBoundary>

      <SectionErrorBoundary label="Water Level Chart">
        <div style={{ padding: 12, color: "#64748b" }}>
          Water Level Chart (real component in Step 8) —{" "}
          {isLoadingHistory ? "loading history..." : `${history.length} history rows loaded`}
        </div>
      </SectionErrorBoundary>

      <div style={{ display: "grid", gap: 12, gridTemplateColumns: "repeat(auto-fill, minmax(280px, 1fr))" }}>
        {STATIONS_LIST.map((name) => {
          const data = stations[name];
          if (!data) return null;
          return (
            <SectionErrorBoundary key={name} label={name}>
              <StationCard name={name} data={data} />
            </SectionErrorBoundary>
          );
        })}
      </div>
    </main>
  );
}