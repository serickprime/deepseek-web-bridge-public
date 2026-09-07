import { createInterface } from "node:readline/promises";
import { stdin as input, stdout as output } from "node:process";
import { buildConfig } from "../src/config/env.js";

const MENU = `
DeepSeek Web Bridge
===================
  [1] Run authorization (npm run auth)
  [2] Run doctor (npm run doctor)
  [3] Start server (npm start)
  [4] Exit

Your choice: `;

async function main(): Promise<void> {
  const rl = createInterface({ input, output });
  const config = buildConfig();
  console.log(`Config: listening on http://${config.host}:${config.port}, base ${config.baseUrl}`);

  for (;;) {
    const answer = (await rl.question(MENU)).trim();
    if (answer === "1") {
      const { runAuth } = await import("./auth.js");
      try {
        await runAuth();
      } catch (error) {
        console.error(error instanceof Error ? error.message : String(error));
      }
    } else if (answer === "2") {
      const { runDoctor } = await import("./doctor.js");
      await runDoctor();
    } else if (answer === "3") {
      const { start } = await import("./start.js");
      await start();
      break;
    } else if (answer === "4") {
      break;
    } else {
      console.log("Unknown option.");
    }
  }
  rl.close();
}

main().catch(error => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
