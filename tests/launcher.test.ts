import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { test } from "node:test";
import type { TestContext } from "node:test";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../", import.meta.url));

function setup(t: TestContext) {
  const temp = realpathSync(mkdtempSync(join(tmpdir(), "my-herdr-test-")));
  t.after(() => rmSync(temp, { recursive: true, force: true }));
  const repo = join(temp, "空白のある repo");
  const git = (...args: string[]) => {
    const result = spawnSync("git", args, { encoding: "utf8" });
    assert.equal(result.status, 0, result.stderr);
    return result.stdout.trim();
  };
  git("init", "--quiet", repo);
  git("-C", repo, "-c", "user.name=テスト", "-c", "user.email=test@example.invalid",
    "-c", "commit.gpgsign=false", "commit", "--quiet", "--allow-empty", "-m", "test: 初期状態");
  const base = git("-C", repo, "rev-parse", "HEAD");
  const log = join(temp, "calls.jsonl");
  const bin = join(temp, "bin");
  mkdirSync(bin);
  const fake = `#!${process.execPath}
const { appendFileSync } = require("node:fs");
const args = process.argv.slice(2);
appendFileSync(process.env.CALL_LOG, JSON.stringify(args) + "\\n");
if (args[0] === "--version") {
  console.log("herdr " + (process.env.FAKE_VERSION || "0.9.5"));
} else if (args[0] === "--help") {
  console.log("--no-alt-screen --add-dir --cd");
} else if (args[0] === "workspace" && args[1] === "create") {
  console.log(process.env.FAKE_CREATE || JSON.stringify({result: {
    workspace: {workspace_id: "w31"}, root_pane: {pane_id: "w31:p99"}
  }}));
} else if (args[0] === "agent" && args[1] === "start" && process.env.FAIL_START) {
  console.error("agent_not_ready"); process.exitCode = 1;
} else if (args[0] === "agent" && args[1] === "prompt" && process.env.FAIL_PROMPT) {
  console.error("timeout"); process.exitCode = 1;
} else {
  console.log(JSON.stringify({result: {}}));
}
`;
  for (const name of ["herdr", "codex"]) {
    writeFileSync(join(bin, name), fake, { mode: 0o755 });
  }
  const env: NodeJS.ProcessEnv = {
    ...process.env, PATH: bin + delimiter + process.env.PATH,
    HERDR_ENV: "1", HERDR_BIN_PATH: join(bin, "herdr"), CALL_LOG: log,
  };
  for (const name of ["FAKE_VERSION", "FAKE_CREATE", "FAIL_START", "FAIL_PROMPT"]) delete env[name];
  const run = (...args: string[]) => spawnSync(process.execPath, [join(root, "my-herdr"), ...args],
    { env, encoding: "utf8", timeout: 15000 });
  const calls = (): string[][] => existsSync(log)
    ? readFileSync(log, "utf8").trim().split("\n").map((line) => {
      const call: unknown = JSON.parse(line);
      assert.ok(Array.isArray(call) && call.every((value) => typeof value === "string"));
      return call;
    }) : [];
  const apiCalls = () => calls().filter((call) => !["--version", "--help"].includes(call[0]));
  return { temp, repo, base, env, git, run, calls, apiCalls };
}

test("司令塔を起動して依頼を送る", (t) => {
  const f = setup(t);
  const task = '表示を修正する。$(touch 注入禁止); "引用"';
  const result = f.run("lead", f.repo, task);
  assert.equal(result.status, 0, result.stderr);
  const calls = f.apiCalls();
  assert.equal(calls.length, 3);
  assert.deepEqual(calls[0], ["workspace", "create", "--cwd", f.repo,
    "--label", "空白のある repo / lead", "--no-focus"]);
  const name = calls[1][2];
  assert.match(name, /^lead-[a-f0-9]{12}$/);
  assert.deepEqual(calls[1], ["agent", "start", name, "--kind", "codex", "--pane", "w31:p99",
    "--", "--no-alt-screen", "--cd", f.repo, "--add-dir", join(f.temp, ".worktrees", "空白のある repo")]);
  assert.deepEqual(calls[2].slice(0, 3), ["agent", "prompt", name]);
  assert.equal(calls[2].length, 4);
  for (const text of [task, f.base, join(root, "prompts/orchestrator.md"), "worktree", "許可"]) {
    assert.ok(calls[2][3].includes(text));
  }
  assert.ok(result.stdout.includes("w31:p99"));
  assert.equal(existsSync(join(f.repo, "注入禁止")), false);
});

test("Herdr外では操作しない", (t) => {
  const f = setup(t);
  delete f.env.HERDR_ENV;
  const result = f.run("lead", f.repo);
  assert.notEqual(result.status, 0);
  assert.ok(result.stderr.includes("Herdr内"));
  assert.deepEqual(f.calls(), []);
});

test("doctorはサーバーを操作しない", (t) => {
  const f = setup(t);
  delete f.env.HERDR_ENV;
  const result = f.run("doctor");
  assert.equal(result.status, 1);
  assert.ok(result.stdout.includes("0.9.5"));
  assert.ok(result.stdout.includes("Herdr内"));
  assert.deepEqual(f.apiCalls(), []);
});

test("古いHerdrを拒否する", (t) => {
  const f = setup(t);
  f.env.FAKE_VERSION = "0.8.0";
  const result = f.run("lead", f.repo);
  assert.notEqual(result.status, 0);
  assert.ok(result.stderr.includes("0.9.5"));
  assert.deepEqual(f.apiCalls(), []);
});

test("Gitリポジトリ以外では起動しない", (t) => {
  const f = setup(t);
  assert.notEqual(f.run("lead", f.temp).status, 0);
  assert.deepEqual(f.apiCalls(), []);
});

test("起動失敗後もworkspaceを保持する", (t) => {
  const f = setup(t);
  f.env.FAIL_START = "1";
  const result = f.run("lead", f.repo);
  assert.notEqual(result.status, 0);
  assert.deepEqual(f.apiCalls().map((call) => call.slice(0, 2)),
    [["workspace", "create"], ["agent", "start"]]);
  assert.ok(result.stderr.includes("w31:p99"));
  assert.ok(result.stderr.includes("保持"));
});

test("依頼の送信失敗後に再送しない", (t) => {
  const f = setup(t);
  f.env.FAIL_PROMPT = "1";
  const result = f.run("lead", f.repo);
  assert.notEqual(result.status, 0);
  assert.equal(f.apiCalls().length, 3);
  assert.ok(result.stderr.includes("再送"));
});

test("IDのない応答は確認を案内する", (t) => {
  const f = setup(t);
  f.env.FAKE_CREATE = '{"result": {}}';
  const result = f.run("lead", f.repo);
  assert.notEqual(result.status, 0);
  assert.equal(f.apiCalls().length, 1);
  assert.ok(result.stderr.includes("workspace list"));
});

test("不正な入れ子JSONでも保持を案内する", (t) => {
  const f = setup(t);
  f.env.FAKE_CREATE = '{"result": {"workspace": null, "root_pane": []}}';
  const result = f.run("lead", f.repo);
  assert.notEqual(result.status, 0);
  assert.ok(result.stderr.includes("保持"));
  assert.equal(f.apiCalls().length, 1);
});

test("初回コミットなしでは起動しない", (t) => {
  const f = setup(t);
  const empty = join(f.temp, "初回コミットなし");
  f.git("init", "--quiet", empty);
  assert.notEqual(f.run("lead", empty).status, 0);
  assert.deepEqual(f.apiCalls(), []);
});

test("元の未コミット変更を保持する", (t) => {
  const f = setup(t);
  const untracked = join(f.repo, "作業中.txt");
  writeFileSync(untracked, "未コミットの作業");
  const result = f.run("lead", f.repo);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(readFileSync(untracked, "utf8"), "未コミットの作業");
  assert.equal(f.git("-C", f.repo, "rev-parse", "HEAD"), f.base);
});

test("複数の司令塔の名前が衝突しない", (t) => {
  const f = setup(t);
  for (let i = 0; i < 2; i++) {
    const result = f.run("lead", f.repo);
    assert.equal(result.status, 0, result.stderr);
  }
  const starts = f.apiCalls().filter((call) => call[0] === "agent" && call[1] === "start");
  assert.equal(starts.length, 2);
  assert.notEqual(starts[0][2], starts[1][2]);
});

test("指定したworktree配置先をCodexへ渡す", (t) => {
  const f = setup(t);
  const worktrees = join(f.temp, "任意の 配置先");
  const result = f.run("lead", f.repo, "調査", "--worktree-root", worktrees);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(existsSync(worktrees), true);
  assert.equal(f.apiCalls()[1].at(-1), worktrees);
  assert.ok(f.apiCalls()[2][3].includes(worktrees));
});

test("クローンしたソースだけで起動できる", (t) => {
  const f = setup(t);
  const checkout = join(f.temp, "clone");
  mkdirSync(checkout);
  for (const name of ["my-herdr", "src", "prompts", "package.json"]) {
    cpSync(join(root, name), join(checkout, name), { recursive: true });
  }
  const result = spawnSync(process.execPath, [join(checkout, "my-herdr"), "lead", f.repo, "調査"],
    { env: f.env, encoding: "utf8", cwd: f.temp, timeout: 15000 });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(existsSync(join(checkout, "node_modules")), false);
  assert.ok(f.apiCalls()[2][3].includes(join(checkout, "prompts/orchestrator.md")));
});

test("不明なオプションではHerdrを操作しない", (t) => {
  const f = setup(t);
  const result = f.run("lead", f.repo, "--unknown-option");
  assert.equal(result.status, 1);
  assert.deepEqual(f.calls(), []);
});
