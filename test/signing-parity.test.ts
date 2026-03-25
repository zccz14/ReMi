import { describe, expect, expectTypeOf, it } from "vitest";
import {
  buildStringToSign as buildCryptoStringToSign,
  hashBody as hashCryptoBody,
} from "../packages/crypto/src/signing.js";
import {
  buildStringToSign as buildWebStringToSign,
  hashBody as hashWebBody,
} from "../packages/web/src/lib/signing";

const BODY_CASES = [
  { name: "undefined", body: undefined },
  { name: "null", body: null },
  { name: "empty", body: new Uint8Array(0) },
  { name: "non-empty", body: new TextEncoder().encode('{"hello":"world"}') },
] satisfies Array<{ name: string; body: Uint8Array | undefined | null }>;

describe("signing helper parity", () => {
  it("exports matching helper signatures", () => {
    expectTypeOf(hashWebBody).toEqualTypeOf<typeof hashCryptoBody>();
    expectTypeOf(buildWebStringToSign).toEqualTypeOf<typeof buildCryptoStringToSign>();
  });
  it.each(BODY_CASES)("hashBody matches for $name", async ({ body }) => {
    await expect(hashWebBody(body)).resolves.toBe(await hashCryptoBody(body));
  });

  it.each(BODY_CASES)("buildStringToSign matches for $name", async ({ body }) => {
    await expect(buildWebStringToSign("POST", "/api/example", "1710000000000", body)).resolves.toBe(
      await buildCryptoStringToSign("POST", "/api/example", "1710000000000", body),
    );
  });
});
