import { resolve } from "node:path";
import dashboard from "./index.html";
import { createApi, TelemetryStore } from "./api";

const configuredPort = process.env.HACKLAB_DASHBOARD_PORT ?? "3000";
if (
  !/^\d{1,5}$/.test(configuredPort) ||
  Number(configuredPort) < 1 ||
  Number(configuredPort) > 65535
) {
  throw new Error(
    "HACKLAB_DASHBOARD_PORT must be an integer between 1 and 65535",
  );
}
// This path is operator configuration only. HTTP inputs never select a database.
const store = new TelemetryStore(
  resolve(
    process.env.HACKLAB_DB ?? `${import.meta.dir}/../.state/tracking.sqlite`,
  ),
);
const api = createApi(store);
const server = Bun.serve({
  hostname: "127.0.0.1",
  port: Number(configuredPort),
  development: false,
  routes: { "/": dashboard },
  fetch(request) {
    return api(request) ?? new Response("Not found", { status: 404 });
  },
  error() {
    return new Response("Dashboard unavailable", { status: 500 });
  },
});
console.log(`Hacklab dashboard: http://127.0.0.1:${server.port}`);
function stop() {
  server.stop(true);
  store.close();
}
process.once("SIGINT", stop);
process.once("SIGTERM", stop);
