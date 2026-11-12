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
};

const xml = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

/**
 * The launchd agent. launchd starts with a bare PATH, and the page shells out
 * to `claude` (state, relay) and to the hive MCP server's command (`bun`), so
 * the PATH names where those live.
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
 * Writes the agent and (re)loads it, so a rebuilt binary takes over. Returns
 * one line for `comb init` to print.
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
  await writeFile(plistPath, plist, "utf-8");

  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env)) if (v !== undefined) env[k] = v;
  const domain = `gui/${uid}`;
  // bootout fails when it was not loaded; that is the normal first time.
  await run(["launchctl", "bootout", `${domain}/${PAGE_LABEL}`], { cwd: o.home, env });
  const res = await run(["launchctl", "bootstrap", domain, plistPath], { cwd: o.home, env });
  if (res.code !== 0) {
    throw new Error(`launchctl bootstrap failed (exit ${res.code}): ${(res.stderr || res.stdout).trim()}`);
  }
  const verb = before === null ? "installed" : "reloaded";
  return `page: ${verb} ${PAGE_LABEL}, serving http://127.0.0.1:${port} (log: ${join(o.home, "logs", "page.log")})`;
}
