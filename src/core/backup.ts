import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { PkbError } from "./errors.js";

const ENGINE_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");

function run(args: string[]): unknown {
  const result = spawnSync("python", ["-X", "utf8", path.join(ENGINE_ROOT, "tools", "backup_vault.py"), ...args], { encoding: "utf8" });
  if (result.error) throw new PkbError("BACKUP_PROCESS_FAILED", result.error.message);
  if (result.status !== 0) throw new PkbError("BACKUP_FAILED", result.stderr.trim());
  return JSON.parse(result.stdout) as unknown;
}

export function createVaultBackup(vaultRoot: string, destination: string): unknown {
  return run(["create", "--vault", path.resolve(vaultRoot), "--destination", path.resolve(destination)]);
}

export function verifyVaultBackup(archive: string): unknown {
  return run(["verify", "--archive", path.resolve(archive)]);
}

export function restoreVaultBackup(archive: string, target: string): unknown {
  return run(["restore", "--archive", path.resolve(archive), "--target", path.resolve(target)]);
}
