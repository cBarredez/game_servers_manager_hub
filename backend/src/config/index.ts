import { readFile } from "node:fs/promises";
import * as TOML from "smol-toml";

export interface AppConfig {
  web: {
    port: number;
    bindIp: string;
    username: string;
    password: string;
    sessionSecret: string;
  };
  podman: {
    reposDir: string;
  };
  ports: {
    webBase: number;
  };
  runtime: {
    timezone: string;
  };
}

interface RawToml {
  [key: string]: unknown;
}

function str(section: RawToml | undefined, key: string, fallback = ""): string {
  const value = section?.[key];
  return typeof value === "string" ? value : fallback;
}

function num(section: RawToml | undefined, key: string, fallback: number): number {
  const value = section?.[key];
  return typeof value === "number" ? value : fallback;
}

export async function loadConfig(mainPath: string, secretsPath: string): Promise<AppConfig> {
  const [mainRaw, secretsRaw] = await Promise.all([
    readFile(mainPath, "utf-8"),
    readFile(secretsPath, "utf-8"),
  ]);

  const main = TOML.parse(mainRaw) as RawToml;
  const secrets = TOML.parse(secretsRaw) as RawToml;

  const mainWeb = main.web as RawToml | undefined;
  const mainPodman = main.podman as RawToml | undefined;
  const mainPorts = main.ports as RawToml | undefined;
  const mainRuntime = main.runtime as RawToml | undefined;
  const secretsWeb = secrets.web as RawToml | undefined;

  const config: AppConfig = {
    web: {
      port: num(mainWeb, "port", 4000),
      bindIp: str(mainWeb, "bind_ip", "127.0.0.1"),
      username: str(mainWeb, "username", "admin"),
      password: str(secretsWeb, "password"),
      sessionSecret: str(secretsWeb, "session_secret"),
    },
    podman: {
      reposDir: str(mainPodman, "repos_dir", ".."),
    },
    ports: {
      webBase: num(mainPorts, "web_base", 9000),
    },
    runtime: {
      timezone: str(mainRuntime, "timezone", "UTC"),
    },
  };

  validateConfig(config);
  return config;
}

export class ConfigValidationError extends Error {}

export function validateConfig(config: AppConfig): void {
  const errors: string[] = [];

  if (!Number.isInteger(config.web.port) || config.web.port < 1 || config.web.port > 65535) {
    errors.push("web.port must be an integer between 1 and 65535");
  }
  if (!config.web.username.trim()) {
    errors.push("web.username must not be empty");
  }
  if (!config.web.password || config.web.password === "change-me") {
    errors.push("web.password secret must be set to a non-default value");
  }
  if (!config.web.sessionSecret || config.web.sessionSecret.length < 32) {
    errors.push("web.session_secret secret must be at least 32 characters");
  }
  if (config.web.sessionSecret.includes("replace-with")) {
    errors.push("web.session_secret secret must not be the placeholder value");
  }
  if (!config.podman.reposDir.trim()) {
    errors.push("podman.repos_dir must not be empty");
  }
  if (
    !Number.isInteger(config.ports.webBase) ||
    config.ports.webBase < 1 ||
    config.ports.webBase > 65000
  ) {
    errors.push("ports.web_base must be an integer between 1 and 65000");
  }

  if (errors.length > 0) {
    throw new ConfigValidationError(`Invalid configuration:\n- ${errors.join("\n- ")}`);
  }
}
