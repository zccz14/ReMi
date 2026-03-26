import { createAvatarClient } from "./avatar-client.ts";
import { parseConfig } from "./config.ts";
import { createOpencodeClient } from "./opencode-client.ts";
import { createTakeoverRunner } from "./takeover-runner.ts";

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function main() {
  const config = parseConfig(process.argv.slice(2));
  const opencode = createOpencodeClient(config.opencodeBaseUrl);
  await opencode.getSession(config.sessionId);
  const logger = {
    info(message: string) {
      process.stdout.write(`${message}\n`);
    },
    warn(message: string) {
      process.stderr.write(`${message}\n`);
    },
    error(message: string) {
      process.stderr.write(`${message}\n`);
    },
  };

  const avatar = createAvatarClient({
    baseUrl: config.avatarBaseUrl,
    model: config.avatarModel,
    apiKey: config.avatarApiKey,
  });

  const runner = createTakeoverRunner({
    sessionId: config.sessionId,
    windowSize: config.windowSize,
    opencode,
    avatar,
    logger,
  });

  while (true) {
    await runner.tick();
    await sleep(config.pollMs);
  }
}

main().catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exit(1);
});
