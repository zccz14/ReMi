import { afterEach, beforeEach, describe, expect, it } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { Hono } from "hono";
import { createApp } from "@remi/server/app";
import { buildStringToSign, generateKeyPair, getPublicKey, sign } from "@remi/crypto";

describe("goal tree routes", () => {
  let tmpDir: string;
  let app: Hono;
  let cleanup: () => void;
  let ownerPrivKey: string;
  let ownerPubKey: string;
  let visitorPrivKey: string;
  let visitorPubKey: string;
  let previousCorsOrigin: string | undefined;

  async function signedRequestWithKey(
    signerPrivKey: string,
    signerPubKey: string,
    method: string,
    urlPath: string,
    body?: string,
  ) {
    const timestamp = String(Date.now());
    const bodyBytes = body ? new TextEncoder().encode(body) : undefined;
    const stringToSign = await buildStringToSign(method, urlPath, timestamp, bodyBytes);
    const signature = await sign(new TextEncoder().encode(stringToSign), signerPrivKey);

    const headers: Record<string, string> = {
      "X-Public-Key": signerPubKey,
      "X-Timestamp": timestamp,
      "X-Signature": signature,
    };

    if (body) {
      headers["Content-Type"] = "application/json";
    }

    return app.request(urlPath, { method, headers, body: body ?? undefined });
  }

  async function ownerRequest(method: string, urlPath: string, body?: string) {
    return signedRequestWithKey(ownerPrivKey, ownerPubKey, method, urlPath, body);
  }

  async function visitorRequest(method: string, urlPath: string, body?: string) {
    return signedRequestWithKey(visitorPrivKey, visitorPubKey, method, urlPath, body);
  }

  beforeEach(() => {
    previousCorsOrigin = process.env.CORS_ORIGIN;
    process.env.CORS_ORIGIN = "https://client.example.test";
    tmpDir = path.join(os.tmpdir(), `remi-goals-routes-${crypto.randomUUID()}`);
    fs.mkdirSync(tmpDir, { recursive: true });

    const result = createApp({ dataDir: tmpDir, embeddingDimensions: 4 });
    app = result.app;
    cleanup = () => result.connMgr.closeAll();

    ownerPrivKey = generateKeyPair();
    ownerPubKey = getPublicKey(ownerPrivKey);
    visitorPrivKey = generateKeyPair();
    visitorPubKey = getPublicKey(visitorPrivKey);
  });

  afterEach(() => {
    cleanup();
    if (previousCorsOrigin === undefined) {
      delete process.env.CORS_ORIGIN;
    } else {
      process.env.CORS_ORIGIN = previousCorsOrigin;
    }
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("creates root, child, and session nodes, lists them, and updates node status", async () => {
    const createRootRes = await ownerRequest(
      "POST",
      `/api/${ownerPubKey}/goals`,
      JSON.stringify({
        type: "goal",
        title: "Launch goal tree",
        objective: "Ship owner goal management",
      }),
    );

    expect(createRootRes.status).toBe(201);
    const { data: root } = await createRootRes.json();
    expect(root.parent_id).toBeNull();
    expect(root.type).toBe("goal");
    expect(root.status).toBe("todo");

    const createChildRes = await ownerRequest(
      "POST",
      `/api/${ownerPubKey}/goals`,
      JSON.stringify({
        parent_id: root.id,
        type: "goal",
        title: "Plan route work",
        objective: "Break down owner endpoints",
      }),
    );

    expect(createChildRes.status).toBe(201);
    const { data: child } = await createChildRes.json();

    const createSessionRes = await ownerRequest(
      "POST",
      `/api/${ownerPubKey}/goals`,
      JSON.stringify({
        parent_id: root.id,
        type: "session",
        title: "Run execution",
        objective: "Create execution leaf",
        dependency_ids: [child.id],
        execution_base_url: "https://exec.example.test",
        external_session_id: "sess-123",
      }),
    );

    expect(createSessionRes.status).toBe(201);
    const { data: session } = await createSessionRes.json();
    expect(session.type).toBe("session");
    expect(session.status).toBe("blocked");
    expect(session.execution_base_url).toBe("https://exec.example.test");
    expect(session.external_session_id).toBe("sess-123");

    const listRes = await ownerRequest("GET", `/api/${ownerPubKey}/goals`);
    expect(listRes.status).toBe(200);
    const listJson = await listRes.json();
    expect(listJson.data.map((node: { id: string }) => node.id)).toEqual([
      root.id,
      child.id,
      session.id,
    ]);

    const doneRes = await ownerRequest(
      "PATCH",
      `/api/${ownerPubKey}/goals/${child.id}`,
      JSON.stringify({ status: "done" }),
    );
    expect(doneRes.status).toBe(200);
    expect((await doneRes.json()).data.status).toBe("done");

    const cancelRes = await ownerRequest(
      "PATCH",
      `/api/${ownerPubKey}/goals/${session.id}`,
      JSON.stringify({ status: "cancelled" }),
    );
    expect(cancelRes.status).toBe(200);
    expect((await cancelRes.json()).data.status).toBe("cancelled");
  });

  it("rejects invalid session and goal field combinations", async () => {
    const createRootRes = await ownerRequest(
      "POST",
      `/api/${ownerPubKey}/goals`,
      JSON.stringify({
        type: "goal",
        title: "Launch goal tree",
        objective: "Ship owner goal management",
      }),
    );
    const { data: root } = await createRootRes.json();

    const missingBaseUrlRes = await ownerRequest(
      "POST",
      `/api/${ownerPubKey}/goals`,
      JSON.stringify({
        parent_id: root.id,
        type: "session",
        title: "Broken session",
        objective: "Missing execution base url",
        external_session_id: "sess-missing-base",
      }),
    );
    expect(missingBaseUrlRes.status).toBe(422);
    expect((await missingBaseUrlRes.json()).message).toContain("execution_base_url is required");

    const missingExternalIdRes = await ownerRequest(
      "POST",
      `/api/${ownerPubKey}/goals`,
      JSON.stringify({
        parent_id: root.id,
        type: "session",
        title: "Broken session",
        objective: "Missing external session id",
        execution_base_url: "https://exec.example.test",
      }),
    );
    expect(missingExternalIdRes.status).toBe(422);
    expect((await missingExternalIdRes.json()).message).toContain(
      "external_session_id is required",
    );

    const goalWithSessionFieldsRes = await ownerRequest(
      "POST",
      `/api/${ownerPubKey}/goals`,
      JSON.stringify({
        parent_id: root.id,
        type: "goal",
        title: "Bad goal",
        objective: "Should reject session-only fields",
        execution_base_url: "https://exec.example.test",
        external_session_id: "sess-should-not-exist",
      }),
    );
    expect(goalWithSessionFieldsRes.status).toBe(422);
    expect((await goalWithSessionFieldsRes.json()).message).toContain(
      "goal nodes cannot include session fields",
    );
  });

  it("rejects sixth child under the same parent", async () => {
    const createRootRes = await ownerRequest(
      "POST",
      `/api/${ownerPubKey}/goals`,
      JSON.stringify({
        type: "goal",
        title: "Launch goal tree",
        objective: "Ship owner goal management",
      }),
    );
    const { data: root } = await createRootRes.json();

    for (let index = 0; index < 5; index += 1) {
      const childRes = await ownerRequest(
        "POST",
        `/api/${ownerPubKey}/goals`,
        JSON.stringify({
          parent_id: root.id,
          type: "goal",
          title: `Child ${index + 1}`,
          objective: `Objective ${index + 1}`,
        }),
      );
      expect(childRes.status).toBe(201);
    }

    const overflowRes = await ownerRequest(
      "POST",
      `/api/${ownerPubKey}/goals`,
      JSON.stringify({
        parent_id: root.id,
        type: "goal",
        title: "Child 6",
        objective: "Should be rejected",
      }),
    );
    expect(overflowRes.status).toBe(422);
    expect((await overflowRes.json()).message).toContain("parent already has maximum children");
  });

  it("rejects self dependency, dependency cycles, and cross-tree dependencies", async () => {
    const rootRes = await ownerRequest(
      "POST",
      `/api/${ownerPubKey}/goals`,
      JSON.stringify({ type: "goal", title: "Root", objective: "Root objective" }),
    );
    const { data: root } = await rootRes.json();

    const otherRootRes = await ownerRequest(
      "POST",
      `/api/${ownerPubKey}/goals`,
      JSON.stringify({ type: "goal", title: "Other Root", objective: "Other root objective" }),
    );
    const { data: otherRoot } = await otherRootRes.json();

    const parentRes = await ownerRequest(
      "POST",
      `/api/${ownerPubKey}/goals`,
      JSON.stringify({
        parent_id: root.id,
        type: "goal",
        title: "Parent",
        objective: "Parent objective",
      }),
    );
    const { data: parent } = await parentRes.json();

    const childRes = await ownerRequest(
      "POST",
      `/api/${ownerPubKey}/goals`,
      JSON.stringify({
        parent_id: parent.id,
        type: "goal",
        title: "Child",
        objective: "Child objective",
      }),
    );
    const { data: child } = await childRes.json();

    const otherTreeChildRes = await ownerRequest(
      "POST",
      `/api/${ownerPubKey}/goals`,
      JSON.stringify({
        parent_id: otherRoot.id,
        type: "goal",
        title: "Other Tree Child",
        objective: "Other tree child objective",
      }),
    );
    const { data: otherTreeChild } = await otherTreeChildRes.json();

    const selfDepRes = await ownerRequest(
      "POST",
      `/api/${ownerPubKey}/goals`,
      JSON.stringify({
        id: "self-dep-node",
        parent_id: root.id,
        type: "goal",
        title: "Self dep",
        objective: "Depends on itself",
        dependency_ids: ["self-dep-node"],
      }),
    );
    expect(selfDepRes.status).toBe(422);
    expect((await selfDepRes.json()).message).toContain("node cannot depend on itself");

    const cycleRes = await ownerRequest(
      "POST",
      `/api/${ownerPubKey}/goals`,
      JSON.stringify({
        parent_id: child.id,
        type: "goal",
        title: "Cycle dep",
        objective: "Would create a cycle",
        dependency_ids: [root.id],
      }),
    );
    expect(cycleRes.status).toBe(422);
    expect((await cycleRes.json()).message).toContain("dependency would create a cycle");

    const crossTreeRes = await ownerRequest(
      "POST",
      `/api/${ownerPubKey}/goals`,
      JSON.stringify({
        parent_id: root.id,
        type: "goal",
        title: "Cross tree dep",
        objective: "Would point outside the tree",
        dependency_ids: [otherTreeChild.id],
      }),
    );
    expect(crossTreeRes.status).toBe(422);
    expect((await crossTreeRes.json()).message).toContain(
      "dependency must stay within the same tree",
    );
  });

  it("rejects visitor access", async () => {
    const createRes = await ownerRequest(
      "POST",
      `/api/${ownerPubKey}/goals`,
      JSON.stringify({ type: "goal", title: "Root", objective: "Root objective" }),
    );
    expect(createRes.status).toBe(201);

    const visitorListRes = await visitorRequest("GET", `/api/${ownerPubKey}/goals`);
    expect(visitorListRes.status).toBe(403);
    expect((await visitorListRes.json()).message).toContain("Owner access required");

    const visitorCreateRes = await visitorRequest(
      "POST",
      `/api/${ownerPubKey}/goals`,
      JSON.stringify({ type: "goal", title: "Bad", objective: "Should fail" }),
    );
    expect(visitorCreateRes.status).toBe(403);
  });

  it("allows PATCH in goal route CORS preflight", async () => {
    const res = await app.request(`/api/${ownerPubKey}/goals/some-node`, {
      method: "OPTIONS",
      headers: {
        Origin: "https://client.example.test",
        "Access-Control-Request-Method": "PATCH",
      },
    });

    expect(res.status).toBe(204);
    expect(res.headers.get("Access-Control-Allow-Methods")).toContain("PATCH");
  });
});
