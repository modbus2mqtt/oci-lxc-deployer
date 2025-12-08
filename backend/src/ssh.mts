import { existsSync, readFileSync } from "fs";
import { homedir } from "os";
import path from "path";
import { ISsh } from "./types.mjs";
import { StorageContext } from "./storagecontext.mjs";
import { spawnSync } from "child_process";

function readServicePublicKey(): string | null {
  // 1) Explicit override via env (absolute path to a public key file)
  const explicit = process.env.LXC_MANAGER_PUBKEY_FILE;
  if (explicit && existsSync(explicit)) {
    try {
      const key = readFileSync(explicit, "utf-8").trim();
      if (key) return key;
    } catch {}
  }

  // 2) Prefer the current user's home (~/.ssh/*) during setup/development
  const currentHome = process.env.HOME || homedir();
  const homes: string[] = [];
  if (currentHome) homes.push(currentHome);

  // 3) Fallbacks (only if not found in current user's home)
  const envServiceHome = process.env.LXC_MANAGER_USER_HOME;
  if (envServiceHome) homes.push(envServiceHome);
  homes.push("/var/lib/lxc-manager", "/home/lxc-manager");

  const filenames = ["id_ed25519.pub", "id_rsa.pub", "id_ecdsa.pub"];

  for (const h of homes) {
    for (const f of filenames) {
      const p = path.join(h, ".ssh", f);
      try {
        if (existsSync(p)) {
          const key = readFileSync(p, "utf-8").trim();
          if (key.length > 0) return key;
        }
      } catch {}
    }
  }
  return null;
}

function buildAppendCommand(pubKey: string, targetFile: string = "~/.ssh/authenticated_keys"): string {
  // Use single quotes around key to avoid shell expansion; comments should not contain single quotes
  return `echo '${pubKey}' >>${targetFile}`;
}

export class Ssh {
  static checkSshPermission(host: string, port?: number): boolean {
    try {
      // Ensure ssh exists
      const sshCmd = "ssh";
      const args = [
        "-o", "BatchMode=yes",
        "-o", "ConnectTimeout=2",
        "-o", "StrictHostKeyChecking=no",
        "-o", "UserKnownHostsFile=/dev/null",
      ];
      if (port && Number.isFinite(port)) {
        args.push("-p", String(port));
      }
      args.push(`root@${host}`, "true");
      const res = spawnSync(sshCmd, args, { stdio: "ignore", timeout: 3000 });
      return res.status === 0;
    } catch {
      return false;
    }
  }
  static getPublicKey(): string | null {
    return readServicePublicKey();
  }

  static getPublicKeyCommand(): string | null {
    const key = this.getPublicKey();
    return key ? buildAppendCommand(key) : null;
  }

  static getInstallSshServerCommand(): string {
    // Debian/Proxmox oriented; create drop-in server config file instead of editing sshd_config
    const cmd =
      "sh -lc 'set -e; " +
      // Install server if apt-get exists
      "if command -v apt-get >/dev/null 2>&1; then apt-get update && DEBIAN_FRONTEND=noninteractive apt-get install -y openssh-server; fi; " +
      // Prepare dirs and drop-in config
      "mkdir -p /root/.ssh /var/run/sshd /etc/ssh/sshd_config.d; " +
      // Write lxc-manager drop-in configuration
      "cat > /etc/ssh/sshd_config.d/lxc-manager.conf <<'EOF'\n" +
      "PermitRootLogin prohibit-password\n" +
      "PubkeyAuthentication yes\n" +
      "PasswordAuthentication no\n" +
      "ChallengeResponseAuthentication no\n" +
      "UsePAM no\n" +
      "AuthorizedKeysFile .ssh/authorized_keys .ssh/authenticated_keys\n" +
      "AllowUsers root\n" +
      "EOF\n" +
      // Enable and restart service (ssh or sshd)
      "(systemctl enable ssh || systemctl enable sshd || true); " +
      "(systemctl restart ssh || systemctl restart sshd || service ssh restart || service sshd restart || true)" +
      "'";
    return cmd;
  }

  /**
   * Build an ISsh descriptor from the current VE context in StorageContext,
   * attaching a publicKeyCommand to be executed on a Proxmox host.
   */
  static fromCurrentContext(storage: StorageContext): ISsh | null {
    const ctx = storage.getCurrentVEContext();
    if (!ctx) return null;
    const pub = this.getPublicKeyCommand();
    const install = this.getInstallSshServerCommand();
    const base: ISsh = { host: ctx.host } as ISsh;
    if (typeof ctx.port === "number") base.port = ctx.port;
    if (typeof ctx.current === "boolean") base.current = ctx.current;
    if (pub) base.publicKeyCommand = pub;
    base.installSshServer = install;
    base.permissionOk = this.checkSshPermission(base.host, base.port);
    return base;
  }

  /**
   * Build ISsh descriptors for all VE contexts.
   */
  static allFromStorage(storage: StorageContext): ISsh[] {
    const result: ISsh[] = [];
    const pubCmd = this.getPublicKeyCommand();
    const install = this.getInstallSshServerCommand();
    for (const key of storage.keys().filter((k) => k.startsWith("ve_"))) {
      const anyCtx: any = storage.get(key);
      if (anyCtx && typeof anyCtx.host === "string") {
        const item: ISsh = { host: anyCtx.host } as ISsh;
        if (typeof anyCtx.port === "number") item.port = anyCtx.port;
        if (typeof anyCtx.current === "boolean") item.current = anyCtx.current;
        if (pubCmd) item.publicKeyCommand = pubCmd;
        item.installSshServer = install;
        item.permissionOk = this.checkSshPermission(item.host, item.port);
        result.push(item);
      }
    }
    return result;
  }
}
