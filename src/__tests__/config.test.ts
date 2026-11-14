import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { DEFAULT_USER_NAME, readCombConfig, userLabel } from "../config";
import { buildSnapshot } from "../page/state";

let home: string;
beforeEach(async () => { home = await mkdtemp(join(tmpdir(), "comb-config-")); });
afterEach(async () => { await rm(home, { recursive: true, force: true }); });

describe("readCombConfig", () => {
  test("no config.json means the default name, You", () => {
    expect(readCombConfig(home)).toEqual({ userName: "You" });
    expect(DEFAULT_USER_NAME).toBe("You");
  });

  test("userName from config.json, trimmed", async () => {
    await writeFile(join(home, "config.json"), JSON.stringify({ userName: "  Ada " }));
    expect(readCombConfig(home).userName).toBe("Ada");
  });

  test("a blank or non-string userName falls back to the default", async () => {
    await writeFile(join(home, "config.json"), JSON.stringify({ userName: "  " }));
    expect(readCombConfig(home).userName).toBe("You");
    await writeFile(join(home, "config.json"), JSON.stringify({ userName: 7 }));
    expect(readCombConfig(home).userName).toBe("You");
  });

  test("bad JSON gives the default and reports it; a missing file reports nothing", async () => {
    const errors: string[] = [];
    readCombConfig(home, (m) => errors.push(m));
    expect(errors).toEqual([]);
    await writeFile(join(home, "config.json"), "{ userName: Ada");
    expect(readCombConfig(home, (m) => errors.push(m)).userName).toBe("You");
    expect(errors).toHaveLength(1);
    expect(errors[0]).toContain("config.json is not valid JSON");
  });
});

test("userLabel: the avatar shows the name's first letter, upper-cased", () => {
  expect(userLabel({ userName: "You" })).toEqual({ name: "You", initial: "Y" });
  expect(userLabel({ userName: "greg" })).toEqual({ name: "greg", initial: "G" });
  expect(userLabel({ userName: "Émile" }).initial).toBe("É");
});

test("the page snapshot carries the configured name; the internal parent id stays greg", async () => {
  expect((await buildSnapshot({ home, live: [], claudeHome: home })).user).toEqual({ name: "You", initial: "Y" });
  await writeFile(join(home, "config.json"), JSON.stringify({ userName: "Greg" }));
  expect((await buildSnapshot({ home, live: [], claudeHome: home })).user).toEqual({ name: "Greg", initial: "G" });
});
