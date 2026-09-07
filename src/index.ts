import { buildApp } from "./app.js";
import { BridgeError } from "./utils/errors.js";

const app = buildApp();
app.server.start().catch(error => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});

process.on("unhandledRejection", (reason) => {
  console.error("Unhandled rejection:", reason);
});

let shuttingDown = false;
async function shutdown(signal: string): Promise<void> {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log(`Received ${signal}, shutting down...`);
  try {
    await app.stop();
    process.exit(0);
  } catch (error) {
    const causeCode = error instanceof BridgeError ? error.causeCode : "shutdown_operation_failed";
    console.error(`Shutdown incomplete (${causeCode ?? "shutdown_operation_failed"}).`);
    process.exit(1);
  }
}

process.on("SIGINT", () => void shutdown("SIGINT"));
process.on("SIGTERM", () => void shutdown("SIGTERM"));
