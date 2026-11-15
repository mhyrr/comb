import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { DEFAULT_USER_NAME, human, readCombConfig, renderTemplate, userLabel } from "../config";
import { detectHive } from "../hive";
import { buildSnapshot } from "../page/state";

let home: string;
beforeEach(async () => {
  home = await mkdtemp(join(tmpdir(), "comb-config-"));
  delete process.env.COMB_HIVE;
});
afterEach(async () => {
  delete process.env.COMB_HIVE;
  await rm(home, { recursive: true, force: true });
});

const write = (o: unknown) => writeFile(join(home, "config.json"), typeof o === "string" ? o : JSON.stringify(o));

describe("readCombConfig", () => {
  test("no config.json: no name, hive auto, no identity file", () => {
    expect(readCombConfig(home)).toEqual({ userName: null, hive: "auto", identityFile: null, nightlyAsks: false });
    expect(DEFAULT_USER_NAME).toBe("You");
  });

  test("reads userName (trimmed), hive, identityFile (with ~ expanded) and nightlyAsks", async () => {
    await write({ userName: "  Ada ", hive: "off", identityFile: "~/me.md", nightlyAsks: true });
    const c = readCombConfig(home);
    expect(c.userName).toBe("Ada");
    expect(c.hive).toBe("off");
    expect(c.identityFile).toBe(join(process.env.HOME!, "me.md"));
    expect(c.nightlyAsks).toBe(true);
  });

  test("blank or wrong-typed values fall back, and a bad hive or nightlyAsks value is reported", async () => {
    await write({ userName: "  ", hive: "maybe", identityFile: 3, nightlyAsks: "yes" });
    const errors: string[] = [];
    expect(readCombConfig(home, (m) => errors.push(m))).toEqual({ userName: null, hive: "auto", identityFile: null, nightlyAsks: false });
    expect(errors).toEqual(['"hive" must be one of auto, on, off; using auto', '"nightlyAsks" must be true or false; using false']);
  });

  test("COMB_HIVE overrides the file", async () => {
    await write({ hive: "off" });
    process.env.COMB_HIVE = "on";
    expect(readCombConfig(home).hive).toBe("on");
  });

  test("bad JSON gives the defaults and reports it; a missing file reports nothing", async () => {
    const errors: string[] = [];
    readCombConfig(home, (m) => errors.push(m));
    expect(errors).toEqual([]);
    await write("{ userName: Ada");
    expect(readCombConfig(home, (m) => errors.push(m)).userName).toBeNull();
    expect(errors).toHaveLength(1);
    expect(errors[0]).toContain("config.json is not valid JSON");
  });
});

test("names: the page says You, prompts say the user, a set name is used everywhere", () => {
  const unset = { userName: null, hive: "auto" as const, identityFile: null, nightlyAsks: false };
  expect(userLabel(unset)).toEqual({ name: "You", initial: "Y" });
  expect(human(unset)).toEqual({ name: "the user", Name: "The user" });
  const set = { ...unset, userName: "greg" };
  expect(userLabel(set)).toEqual({ name: "greg", initial: "G" });
  expect(human(set)).toEqual({ name: "greg", Name: "greg" });
  expect(userLabel({ ...unset, userName: "Émile" }).initial).toBe("É");
});

test("renderTemplate fills names and keeps the hive or no-hive blocks", () => {
  const t = "Hi {{user}}. {{User}} decides.\n{{#hive}}\nhive line\n{{/hive}}\n{{^hive}}\nplain line\n{{/hive}}\nend";
  const who = { name: "the user", Name: "The user" };
  expect(renderTemplate(t, { human: who, hive: true })).toBe("Hi the user. The user decides.\nhive line\nend");
  expect(renderTemplate(t, { human: who, hive: false })).toBe("Hi the user. The user decides.\nplain line\nend");
});

test("the shipped templates render cleanly both ways; without hive, Maya's charter never mentions hive", async () => {
  const charter = await Bun.file(join(import.meta.dir, "..", "..", "templates", "maya-charter.md")).text();
  const identity = await Bun.file(join(import.meta.dir, "..", "..", "templates", "identity.md")).text();
  const greg = { name: "Greg", Name: "Greg" };
  const withHive = renderTemplate(charter, { human: greg, hive: true });
  expect(withHive).not.toContain("{{");
  expect(withHive).toContain("cwd: the project's `path` in `~/.hive/projects/<name>/config.md`;");
  expect(withHive).toContain("Hive tickets and memory, through the hive MCP tools.");
  expect(withHive).toContain("Small things you do yourself: a memory note, a ticket update, a lookup.");
  expect(withHive).toContain("You keep Greg's work moving so Greg is not the bottleneck.");
  const plain = renderTemplate(charter, { human: { name: "the user", Name: "The user" }, hive: false });
  expect(plain).not.toContain("{{");
  expect(plain).not.toMatch(/hive|Greg/i);
  expect(plain).toContain("Small things you do yourself: a lookup.");
  expect(plain).toContain("The user's sessions are outside your tree.");
  expect(renderTemplate(identity, { human: greg, hive: false })).not.toContain("{{");
});

describe("detectHive", () => {
  const exists = (paths: string[]) => (p: string) => paths.includes(p);

  test("auto: on only with both the CLI and hive's home", () => {
    expect(detectHive({ mode: "auto", hiveHome: "/h", locate: () => "hive", exists: exists(["/h"]) })).toMatchObject({ enabled: true, bin: "hive" });
    expect(detectHive({ mode: "auto", hiveHome: "/h", locate: () => null, exists: exists(["/h"]) })).toMatchObject({
      enabled: false, why: "no hive CLI on PATH or in ~/.local/bin",
    });
    expect(detectHive({ mode: "auto", hiveHome: "/h", locate: () => "hive", exists: exists([]) })).toMatchObject({
      enabled: false, why: "found hive, but /h does not exist",
    });
  });

  test("auto keeps a ~/.local/bin hive as an absolute path, for launchd's short PATH", () => {
    expect(detectHive({ mode: "auto", hiveHome: "/h", locate: () => "/u/.local/bin/hive", exists: exists(["/h"]) }).bin).toBe("/u/.local/bin/hive");
  });

  test("on always uses hive, so a missing hive fails loudly at start; off never does", () => {
    expect(detectHive({ mode: "on", hiveHome: "/h", locate: () => null, exists: exists([]) })).toMatchObject({ enabled: true, bin: "hive" });
    expect(detectHive({ mode: "off", hiveHome: "/h", locate: () => "hive", exists: exists(["/h"]) })).toMatchObject({ enabled: false });
  });

  test("the mode comes from config.json when not given", async () => {
    await mkdir(home, { recursive: true });
    await write({ hive: "off" });
    const saved = process.env.COMB_HOME;
    process.env.COMB_HOME = home;
    try {
      expect(detectHive({ hiveHome: "/h", locate: () => "hive", exists: exists(["/h"]) }).mode).toBe("off");
    } finally {
      if (saved === undefined) delete process.env.COMB_HOME;
      else process.env.COMB_HOME = saved;
    }
  });
});

test("the page snapshot carries the name and whether hive is on; the parent id stays greg", async () => {
  const snap = await buildSnapshot({ home, live: [], claudeHome: home, hive: false });
  expect(snap.user).toEqual({ name: "You", initial: "Y" });
  expect(snap.hive).toBe(false);
  await write({ userName: "Greg" });
  const again = await buildSnapshot({ home, live: [], claudeHome: home, hive: true });
  expect(again.user).toEqual({ name: "Greg", initial: "G" });
  expect(again.hive).toBe(true);
});
