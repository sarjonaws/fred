/**
 * Lectura de metadatos de git del repo analizado (solo stdlib).
 * Cada dato se obtiene por separado: un repo sin remote sigue teniendo SHA,
 * y una carpeta sin git simplemente no aporta nada (no es un error).
 */
import { execSync } from "node:child_process";

export interface GitInfo {
  commitSha?: string;
  branch?: string;
  remote?: string;
}

function git(repoRoot: string, args: string): string | undefined {
  try {
    const out = execSync(`git -C "${repoRoot}" ${args}`, {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
    return out || undefined;
  } catch {
    return undefined;
  }
}

export function gitInfo(repoRoot: string): GitInfo {
  return {
    commitSha: git(repoRoot, "rev-parse HEAD"),
    branch: git(repoRoot, "rev-parse --abbrev-ref HEAD"),
    remote: git(repoRoot, "remote get-url origin"),
  };
}

/** Nombre del repo a partir del remote: ".../mi-repo.git" -> "mi-repo". */
export function repoNameFromRemote(remote: string): string | undefined {
  const last = remote.replace(/\/+$/, "").split(/[/:]/).pop();
  if (!last) return undefined;
  return last.replace(/\.git$/, "") || undefined;
}
