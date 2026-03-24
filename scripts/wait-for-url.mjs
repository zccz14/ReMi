#!/usr/bin/env node

import process from "node:process";
import { setTimeout as delay } from "node:timers/promises";

const [url, timeoutMsArg] = process.argv.slice(2);
const timeoutMs = Number(timeoutMsArg ?? 5000);
const deadline = Date.now() + timeoutMs;
const intervalMs = 100;

if (!url || !Number.isFinite(timeoutMs) || timeoutMs <= 0) {
  process.stderr.write("Usage: node scripts/wait-for-url.mjs <url> <timeoutMs>\n");
  process.exit(1);
}

while (Date.now() <= deadline) {
  try {
    const response = await globalThis.fetch(url);
    if (response.ok) {
      process.exit(0);
    }
  } catch {
    // retry until timeout
  }

  await delay(intervalMs);
}

process.stderr.write(`Timed out waiting for ${url}\n`);
process.exit(1);
