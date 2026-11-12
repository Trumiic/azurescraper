/**
 * Server configuration from environment variables (Docker / Unraid template).
 * API keys now live in Settings -> Connections; env vars still work as a fallback.
 */
export const config = {
  port: Number(process.env.PORT ?? 3933),
  host: process.env.HOST ?? "0.0.0.0",
  // Docker sets DATA_DIR=/data; locally it defaults to ./data
  dataDir: process.env.DATA_DIR ?? "./data",
  kroger: {
    baseUrl: process.env.KROGER_BASE_URL ?? "https://api.kroger.com/v1",
  },
};
