"use client";

export default function Error({ error, reset }: { error: Error; reset: () => void }) {
  return (
    <div style={{ padding: 24, fontFamily: "sans-serif" }}>
      <h2>Something went wrong displaying the dashboard.</h2>
      <p style={{ color: "gray" }}>{error.message}</p>
      <button onClick={() => reset()}>Try again</button>
    </div>
  );
}