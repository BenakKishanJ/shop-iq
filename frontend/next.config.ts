import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // Build a fully static site (frontend/out/) so the FastAPI backend can
  // serve the UI from the same process — one image to deploy.
  output: "export",
};

export default nextConfig;
