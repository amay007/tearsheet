import { ImageResponse } from "next/og";

export const alt = "TearSheet — blunt, evidence-backed company teardowns";
export const size = { width: 1200, height: 630 };
export const contentType = "image/png";

export default function Image() {
  return new ImageResponse(
    (
      <div
        style={{
          width: "100%",
          height: "100%",
          display: "flex",
          flexDirection: "column",
          alignItems: "center",
          justifyContent: "center",
          background: "#0a0a0a",
          color: "#ededed",
          fontFamily: "sans-serif",
        }}
      >
        <div style={{ display: "flex", fontSize: 104, fontWeight: 700, letterSpacing: -3 }}>
          TearSheet
        </div>
        <div style={{ display: "flex", fontSize: 34, color: "rgba(237,237,237,0.65)", marginTop: 20 }}>
          Blunt, evidence-backed company teardowns
        </div>
      </div>
    ),
    { ...size }
  );
}
