import type { BodyJson } from "./types.js";

export function canonicalizeBodyJson(input: unknown): string {
  const body = asBodyJson(input);

  if (!hasOwn(body, "type") || body.type === undefined) {
    throw new Error("body_json.type is required");
  }

  if (!hasOwn(body, "version") || body.version === undefined) {
    throw new Error("body_json.version is required");
  }

  return JSON.stringify(sortJsonValue(body));
}

function asBodyJson(input: unknown): BodyJson {
  if (!isPlainObject(input)) {
    throw new Error("body_json must be an object");
  }

  return input as BodyJson;
}

function sortJsonValue(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map((item) => sortJsonValue(item));
  }

  if (isPlainObject(value)) {
    return Object.keys(value)
      .sort()
      .reduce<Record<string, unknown>>((acc, key) => {
        acc[key] = sortJsonValue(value[key]);
        return acc;
      }, {});
  }

  return value;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hasOwn<T extends object>(value: T, key: PropertyKey): boolean {
  return Object.prototype.hasOwnProperty.call(value, key);
}
