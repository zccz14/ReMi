export interface TakeoverConfig {
  sessionId: string;
  writeApiConfirmed: boolean;
  avatarBaseUrl: string;
  avatarModel: string;
  avatarApiKey?: string;
  opencodeBaseUrl: string;
  pollMs: number;
  windowSize: number;
}

function readFlag(argv: string[], name: string) {
  const prefix = `--${name}=`;
  const match = argv.find((item) => item.startsWith(prefix));
  return match ? match.slice(prefix.length) : undefined;
}

function requireFlag(argv: string[], name: string) {
  const value = readFlag(argv, name);
  if (!value) throw new Error(`Missing required flag: --${name}`);
  return value;
}

function readNumberFlag(argv: string[], name: string, fallback: number) {
  const raw = readFlag(argv, name);
  if (!raw) return fallback;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    throw new Error(`Invalid numeric flag: --${name}`);
  }
  return parsed;
}

export function parseConfig(argv: string[]): TakeoverConfig {
  const sessionId = requireFlag(argv, "session-id");
  const writeApiConfirmed = requireFlag(argv, "write-api-confirmed") === "true";
  if (!writeApiConfirmed) {
    throw new Error("--write-api-confirmed=true is required");
  }

  return {
    sessionId,
    writeApiConfirmed,
    avatarBaseUrl: requireFlag(argv, "avatar-base-url"),
    avatarModel: requireFlag(argv, "avatar-model"),
    avatarApiKey: readFlag(argv, "avatar-api-key"),
    opencodeBaseUrl: readFlag(argv, "opencode-base-url") ?? "http://localhost:4096",
    pollMs: readNumberFlag(argv, "poll-ms", 2000),
    windowSize: readNumberFlag(argv, "window-size", 8),
  };
}
