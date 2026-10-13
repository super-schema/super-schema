import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

export function loadEnvFile(envPath = resolve(process.cwd(), ".env")) {
  if (!existsSync(envPath)) return;

  const source = readFileSync(envPath, "utf8");
  for (const line of source.split(/\r?\n/)) {
    const assignment = parseEnvAssignment(line);
    if (!assignment) continue;

    const [key, value] = assignment;
    if (process.env[key] === undefined) {
      process.env[key] = value;
    }
  }
}

function parseEnvAssignment(line: string): [string, string] | null {
  const trimmed = line.trim();
  if (!trimmed || trimmed.startsWith("#")) return null;

  const normalized = trimmed.startsWith("export ") ? trimmed.slice(7).trimStart() : trimmed;
  const separatorIndex = normalized.indexOf("=");
  if (separatorIndex <= 0) return null;

  const key = normalized.slice(0, separatorIndex).trim();
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) return null;

  const rawValue = normalized.slice(separatorIndex + 1).trim();
  return [key, parseEnvValue(rawValue)];
}

function parseEnvValue(rawValue: string): string {
  if (rawValue.length < 2) {
    return rawValue;
  }

  const quote = rawValue[0];
  if ((quote === '"' || quote === "'") && rawValue.endsWith(quote)) {
    const unquoted = rawValue.slice(1, -1);
    return quote === '"' ? unquoted.replace(/\\n/g, "\n") : unquoted;
  }

  const commentIndex = rawValue.search(/\s#/);
  return commentIndex === -1 ? rawValue : rawValue.slice(0, commentIndex).trimEnd();
}
