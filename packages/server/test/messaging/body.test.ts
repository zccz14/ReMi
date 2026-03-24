import { describe, expect, it } from "vitest";

import { canonicalizeBodyJson } from "../../src/messaging/body.js";

describe("canonicalizeBodyJson", () => {
  it("produces stable output regardless of object key order", () => {
    const a = {
      version: 1,
      type: "text",
      text: "hello",
      meta: {
        z: 2,
        a: 1,
      },
    };

    const b = {
      text: "hello",
      meta: {
        a: 1,
        z: 2,
      },
      type: "text",
      version: 1,
    };

    expect(canonicalizeBodyJson(a)).toBe(canonicalizeBodyJson(b));
    expect(canonicalizeBodyJson(a)).toBe(
      '{"meta":{"a":1,"z":2},"text":"hello","type":"text","version":1}',
    );
  });

  it("requires a type field", () => {
    expect(() => canonicalizeBodyJson({ version: 1, text: "hello" })).toThrow(/type/i);
  });

  it("requires a version field", () => {
    expect(() => canonicalizeBodyJson({ type: "text", text: "hello" })).toThrow(/version/i);
  });

  it("rejects type and version inherited from the prototype chain", () => {
    const inheritedOnly = Object.create({
      type: "text",
      version: 1,
    }) as Record<string, unknown>;
    inheritedOnly.text = "hello";

    expect(() => canonicalizeBodyJson(inheritedOnly)).toThrow(/type/i);
  });

  it("preserves unknown message types while canonicalizing", () => {
    expect(
      canonicalizeBodyJson({
        payload: { z: true, a: true },
        version: 7,
        type: "future-widget",
      }),
    ).toBe('{"payload":{"a":true,"z":true},"type":"future-widget","version":7}');
  });
});
