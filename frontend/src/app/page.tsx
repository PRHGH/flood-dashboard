"use client";
import { useScadaData } from "@/hooks/use-scada-data";

export default function Home() {
  useScadaData();
  return <div>Check the browser console.</div>;
}