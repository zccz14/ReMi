import { afterEach, describe, expect, it } from "vitest";
import { createServer, type Server } from "node:http";
import { spawn } from "node:child_process";
import { once } from "node:events";

const helperPath = new URL("../scripts/wait-for-url.mjs", import.meta.url);

const servers = new Set<Server>();

async function listen(server: Server): Promise<number> {
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  if (!address || typeof address === "string") {
    throw new Error("Expected TCP server address");
  }
  servers.add(server);
  return address.port;
}

async function closeServer(server: Server): Promise<void> {
  if (!server.listening) return;
  await new Promise<void>((resolve, reject) => {
    server.close((error) => {
      if (error) reject(error);
      else resolve();
    });
  });
  servers.delete(server);
}

function runHelper(args: string[]): Promise<{ code: number | null; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [helperPath.pathname, ...args], {
      stdio: ["ignore", "ignore", "pipe"],
    });

    let stderr = "";
    child.stderr.on("data", (chunk) => {
      stderr += String(chunk);
    });
    child.on("error", reject);
    child.on("close", (code) => {
      resolve({ code, stderr });
    });
  });
}

afterEach(async () => {
  await Promise.all([...servers].map(closeServer));
});

describe("wait-for-url helper", () => {
  it("exits zero when the target URL becomes reachable", async () => {
    const server = createServer((_req, res) => {
      res.statusCode = 200;
      res.end("ok");
    });
    const port = await listen(server);

    const result = await runHelper([`http://127.0.0.1:${port}/health`, "1500"]);

    expect(result.code).toBe(0);
    expect(result.stderr).toBe("");
  });

  it("fails non-zero when the target URL never becomes reachable", async () => {
    const result = await runHelper(["http://127.0.0.1:9/health", "150"]);

    expect(result.code).toBe(1);
    expect(result.stderr).toContain("Timed out");
  });

  it("keeps polling until the URL becomes reachable before timeout", async () => {
    const server = createServer((_req, res) => {
      res.statusCode = 200;
      res.end("ok");
    });
    const port = await new Promise<number>((resolve) => {
      const temp = createServer();
      temp.listen(0, "127.0.0.1", () => {
        const address = temp.address();
        if (!address || typeof address === "string") {
          throw new Error("Expected TCP server address");
        }
        const chosenPort = address.port;
        temp.close(() => resolve(chosenPort));
      });
    });

    const helperPromise = runHelper([`http://127.0.0.1:${port}/health`, "1500"]);

    await new Promise((resolve) => setTimeout(resolve, 150));
    server.listen(port, "127.0.0.1");
    await once(server, "listening");
    servers.add(server);

    const result = await helperPromise;
    expect(result.code).toBe(0);
    expect(result.stderr).toBe("");
  });
});
