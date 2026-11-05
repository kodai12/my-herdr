import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdirSync, realpathSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";

const root = fileURLToPath(new URL("../", import.meta.url));

function run(command: string, ...args: string[]): string {
  const result = spawnSync(command, args, {
    encoding: "utf8", timeout: 45000, killSignal: "SIGKILL", maxBuffer: 8 * 1024 * 1024,
  });
  if (result.error) throw new Error(`${command}を実行できませんでした: ${result.error.message}`);
  if (result.status !== 0) {
    throw new Error(result.stderr.trim() || result.stdout.trim() ||
      `${command}が終了コード${result.status}で失敗しました。`);
  }
  return result.stdout.trim();
}

function dependencies(): string {
  const herdr = process.env.HERDR_BIN_PATH || "herdr";
  const version = run(herdr, "--version");
  console.log(`Herdr: ${version} (${herdr})`);
  const match = version.match(/\b(\d+)\.(\d+)\.(\d+)\b/);
  if (!match) throw new Error("Herdr v0.9.5以上を使用してください。");
  const [major, minor, patch] = match.slice(1).map(Number);
  if (major === 0 && (minor < 9 || (minor === 9 && patch < 5))) {
    throw new Error("Herdr v0.9.5以上を使用してください。");
  }
  const help = run("codex", "--help");
  if (["--no-alt-screen", "--add-dir", "--cd"].some((flag) => !help.includes(flag))) {
    throw new Error("必要な起動オプションに対応したCodex CLIへ更新してください。");
  }
  run("git", "--version");
  return herdr;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function api(herdr: string, ...args: string[]): Record<string, unknown> {
  const output = run(herdr, ...args);
  try {
    const response: unknown = JSON.parse(output);
    if (isRecord(response) && isRecord(response.result)) return response.result;
  } catch (error) {
    if (!(error instanceof SyntaxError)) throw error;
  }
  throw new Error("Herdrの応答を確認できません。herdr workspace listで状態を確認してください。");
}

function expandUser(path: string): string {
  if (path === "~") return homedir();
  return path.startsWith("~/") ? join(homedir(), path.slice(2)) : path;
}

function launch(herdr: string, repoPath: string, task: string, worktreeRoot?: string): void {
  const repo = realpathSync(run("git", "-C", resolve(expandUser(repoPath)), "rev-parse", "--show-toplevel"));
  const base = run("git", "-C", repo, "rev-parse", "--verify", "HEAD^{commit}");
  const requested = worktreeRoot ? resolve(expandUser(worktreeRoot)) : join(dirname(repo), ".worktrees", basename(repo));
  mkdirSync(requested, { recursive: true });
  const worktrees = realpathSync(requested);
  let workspace: string | undefined;
  let pane: string | undefined;
  const name = "lead-" + randomUUID().replaceAll("-", "").slice(0, 12);
  try {
    const created = api(herdr, "workspace", "create", "--cwd", repo,
      "--label", basename(repo) + " / lead", "--no-focus");
    const workspaceData = isRecord(created.workspace) ? created.workspace : {};
    const paneData = isRecord(created.root_pane) ? created.root_pane : {};
    workspace = typeof workspaceData.workspace_id === "string" ? workspaceData.workspace_id : undefined;
    pane = typeof paneData.pane_id === "string" ? paneData.pane_id : undefined;
    if (!workspace || !pane) {
      throw new Error("Herdr応答のIDが不明です。herdr workspace listで状態を確認してください。");
    }
    api(herdr, "agent", "start", name, "--kind", "codex", "--pane", pane,
      "--", "--no-alt-screen", "--cd", repo, "--add-dir", worktrees);
    const context = JSON.stringify({ repository: repo, base_commit: base,
      worktree_root: worktrees, workspace_id: workspace, orchestrator: name });
    const prompt = [
      "あなたはCodexの司令塔です。まず次の運用指示を読み、herdr --skillで操作仕様を確認してください。",
      `運用指示: ${JSON.stringify(join(root, "prompts/orchestrator.md"))}`,
      "ユーザーは今回の依頼の範囲で、worktree、workspace、tab、paneの作成と" +
      "Codex作業者の起動、依頼、進捗確認を追加確認なしで行うことを許可しています。",
      `起動時のコンテキスト: ${context}`,
      "以降はユーザーの依頼本文です。",
      task || "まず依頼を受け付けられることと、現在の作業場所を伝えて待機してください。",
    ].join("\n");
    api(herdr, "agent", "prompt", name, prompt);
  } catch (error) {
    throw new Error(
      `${error instanceof Error ? error.message : String(error)}\n作成されたworkspaceは保持します。` +
      ` workspace=${workspace || "未確認"}, pane=${pane || "未確認"}, agent=${name}\n` +
      "herdr workspace listとherdr agent listで状態を確認してください。" +
      "依頼の到達は未確認のため、自動で再送しません。",
    );
  }
  console.log(`司令塔へ依頼を送信しました。workspace=${workspace}, pane=${pane}, agent=${name}`);
  console.log(`表示するには: herdr workspace focus ${workspace}`);
  console.log("送信の成功は作業開始や完了を保証しません。状態と出力を確認してください。");
}

function main(): number {
  const { values, positionals } = parseArgs({
    args: process.argv.slice(2), allowPositionals: true,
    options: { "worktree-root": { type: "string" }, help: { type: "boolean", short: "h" } },
  });
  if (values.help) {
    console.log("使い方: my-herdr doctor | lead REPO [TASK] [--worktree-root PATH]");
    return 0;
  }
  const [command, repo, task = ""] = positionals;
  if (!((command === "doctor" && positionals.length === 1 && !values["worktree-root"]) ||
    (command === "lead" && repo && positionals.length <= 3))) {
    throw new Error("使い方: my-herdr doctor | lead REPO [TASK] [--worktree-root PATH]");
  }
  const inside = process.env.HERDR_ENV === "1";
  if (command === "lead" && !inside) {
    throw new Error("Herdr内のシェルで実行してください。先にherdrを起動してください。");
  }
  const herdr = dependencies();
  if (command === "doctor") {
    console.log("Codex CLIの必要オプション: 確認済み");
    console.log(`Herdr内: ${inside ? "はい" : "いいえ（起動はHerdr内で実行してください）"}`);
    return inside ? 0 : 1;
  }
  launch(herdr, repo, task, values["worktree-root"]);
  return 0;
}

try {
  process.exitCode = main();
} catch (error) {
  console.error(`my-herdr: ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
}
