/**
 * Keeps comb's page running: a launchd agent that starts `comb page` at
 * login and restarts it if it exits, the same way hive serves its dashboard.
 * Greg never starts the page himself (D16); it is simply there.
 */
import { existsSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

import { runProcess, type Run } from "../claude";

export const PAGE_LABEL = "com.comb.page";
export const PAGE_PORT = 4747;

export type ServiceOpts = {
  /** comb's state folder; the log goes in logs/ there. */
  home: string;
  /** The installed comb binary the service runs. */
  bin?: string;
  launchAgentsDir?: string;
  port?: number;
  run?: Run;
  uid?: number;
  /** Wait before the one bootstrap retry. Tests pass 0. */
  retryDelayMs?: number;
};

const xml = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

/**
 * The launchd agent. launchd starts with a bare PATH, and the page shells out
 * to `claude` (state, relay) and to the hive MCP server's command (`bun`), so
 * the PATH names where those live.
 *
 * The program is /bin/sh, which execs comb (TK-006). macOS's Background Task
 * Management keys a login item on its program's code requirement. comb's is
 * ad-hoc, so the requirement is the cdhash, and every build is new code: each
 * install showed "comb can run in the background". /bin/sh is Apple-signed
 * and never changes, so rebuilding comb is not a new login item.
 */
export function pagePlist(o: { bin: string; home: string; port: number; userHome: string }): string {
  const path = [`${o.userHome}/.local/bin`, `${o.userHome}/.bun/bin`, "/opt/homebrew/bin", "/usr/local/bin", "/usr/bin", "/bin"].join(":");
  const log = join(o.home, "logs", "page.log");
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>Label</key>
    <string>${PAGE_LABEL}</string>
    <key>ProgramArguments</key>
    <array>
        <string>/bin/sh</string>
        <string>-c</string>
        <string>exec "$0" "$@"</string>
        <string>${xml(o.bin)}</string>
        <string>page</string>
        <string>--serve</string>
        <string>--port</string>
        <string>${o.port}</string>
    </array>
    <key>EnvironmentVariables</key>
    <dict>
        <key>PATH</key>
        <string>${xml(path)}</string>
        <key>COMB_HOME</key>
        <string>${xml(o.home)}</string>
    </dict>
    <key>WorkingDirectory</key>
    <string>${xml(o.home)}</string>
    <key>KeepAlive</key>
    <true/>
    <key>RunAtLoad</key>
    <true/>
    <key>ThrottleInterval</key>
    <integer>5</integer>
    <key>StandardOutPath</key>
    <string>${xml(log)}</string>
    <key>StandardErrorPath</key>
    <string>${xml(log)}</string>
</dict>
</plist>
`;
}

/**
 * Puts the page service on the installed binary. Returns one line for
 * `comb init` to print.
 *
 * When the plist on disk is already right, the file is left alone and the
 * running service is restarted in place (`kickstart -k`). Rewriting the plist,
 * even with the same bytes, makes launchd rescan LaunchAgents and BTM re-check
 * the item. A full bootout and bootstrap also races (exit 5). If kickstart
 * fails (the service is not loaded, say), it falls back to the full reload and
 * says so. The bootstrap is retried once, because that race usually clears.
 */
export async function installPageService(o: ServiceOpts): Promise<string> {
  const userHome = process.env.HOME || homedir();
  const bin = o.bin ?? join(userHome, ".local", "bin", "comb");
  const dir = o.launchAgentsDir ?? join(userHome, "Library", "LaunchAgents");
  const port = o.port ?? PAGE_PORT;
  const run = o.run ?? runProcess;
  const uid = o.uid ?? process.getuid?.() ?? 501;

  if (process.platform !== "darwin" && !o.launchAgentsDir) return "page: not macOS; run `comb page` yourself";
  if (!existsSync(bin)) return `page: ${bin} is not installed yet; build and install comb, then run comb init again`;

  await mkdir(join(o.home, "logs"), { recursive: true });
  await mkdir(dir, { recursive: true });
  const plistPath = join(dir, `${PAGE_LABEL}.plist`);
  const plist = pagePlist({ bin, home: o.home, port, userHome });
  const before = existsSync(plistPath) ? await readFile(plistPath, "utf-8") : null;

  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env)) if (v !== undefined) env[k] = v;
  const launchctl = (...args: string[]) => run(["launchctl", ...args], { cwd: o.home, env });
  const domain = `gui/${uid}`;
  const serving = `serving http://127.0.0.1:${port} (log: ${join(o.home, "logs", "page.log")})`;

  let note = "";
  if (before === plist) {
    const kick = await launchctl("kickstart", "-k", `${domain}/${PAGE_LABEL}`);
    if (kick.code === 0) return `page: restarted ${PAGE_LABEL} on the installed binary (plist unchanged), ${serving}`;
    note = ` (kickstart failed, exit ${kick.code}: ${(kick.stderr || kick.stdout).trim() || "no output"}; reloaded instead)`;
  } else {
    await writeFile(plistPath, plist, "utf-8");
  }

  // bootout fails when it was not loaded; that is the normal first time.
  await launchctl("bootout", `${domain}/${PAGE_LABEL}`);
  let res = await launchctl("bootstrap", domain, plistPath);
  if (res.code !== 0) {
    await Bun.sleep(o.retryDelayMs ?? 1000);
    res = await launchctl("bootstrap", domain, plistPath);
  }
  if (res.code !== 0) {
    throw new Error(`launchctl bootstrap failed (exit ${res.code}) twice: ${(res.stderr || res.stdout).trim()}${note}`);
  }
  const verb = before === null ? "installed" : "reloaded";
  return `page: ${verb} ${PAGE_LABEL}${note}, ${serving}`;
}
