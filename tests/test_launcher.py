"""起動処理の外部コマンド境界と失敗時の状態保持を検証する。"""

import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest


ROOT = Path(__file__).resolve().parents[1]


class LauncherTest(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix="my-herdr-test-")
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name).resolve()
        self.repo = self.root / "空白のある repo"
        self.repo.mkdir()
        subprocess.run(["git", "init", "--quiet", str(self.repo)], check=True)
        subprocess.run(
            ["git", "-C", str(self.repo), "-c", "user.name=テスト", "-c",
             "user.email=test@example.invalid", "-c", "commit.gpgsign=false",
             "commit", "--quiet", "--allow-empty", "-m", "test: 初期状態"],
            check=True,
        )
        self.base = subprocess.check_output(
            ["git", "-C", str(self.repo), "rev-parse", "HEAD"], text=True
        ).strip()
        self.log = self.root / "calls.jsonl"
        self.bin = self.root / "bin"
        self.bin.mkdir()
        fake = """#!{python}
import json, os, sys
a = sys.argv[1:]
with open(os.environ['CALL_LOG'], 'a') as f:
    f.write(json.dumps([os.path.basename(sys.argv[0]), *a]) + '\\n')
if a == ['--version']:
    print('herdr ' + os.environ.get('FAKE_VERSION', '0.9.5'))
elif a == ['--help']:
    print('--no-alt-screen --add-dir --cd')
elif a[:2] == ['workspace', 'create']:
    print(os.environ.get('FAKE_CREATE', json.dumps({{'ok': True, 'result': {{
        'workspace': {{'workspace_id': 'w31'}},
        'root_pane': {{'pane_id': 'w31:p99'}}
    }}}})))
elif a[:2] == ['agent', 'start'] and os.environ.get('FAIL_START'):
    print('agent_not_ready', file=sys.stderr)
    sys.exit(1)
elif a[:2] == ['agent', 'prompt'] and os.environ.get('FAIL_PROMPT'):
    print('timeout', file=sys.stderr)
    sys.exit(1)
else:
    print(json.dumps({{'ok': True, 'result': {{}}}}))
""".format(python=sys.executable)
        for name in ("herdr", "codex"):
            path = self.bin / name
            path.write_text(fake, encoding="utf-8")
            path.chmod(0o755)
        self.env = dict(os.environ, PATH=str(self.bin) + os.pathsep + os.environ["PATH"],
                        HERDR_ENV="1", HERDR_BIN_PATH=str(self.bin / "herdr"),
                        CALL_LOG=str(self.log))
        for name in ("FAKE_VERSION", "FAKE_CREATE", "FAIL_START", "FAIL_PROMPT"):
            self.env.pop(name, None)

    def run_cli(self, *args):
        return subprocess.run([sys.executable, str(ROOT / "my-herdr"), *args],
                              env=self.env, text=True, capture_output=True)

    def calls(self):
        return [json.loads(line) for line in self.log.read_text().splitlines()] if self.log.exists() else []

    def api_calls(self):
        return [call[1:] for call in self.calls() if call[1] not in ("--version", "--help")]

    def test_launch(self):
        task = '表示を修正する。$(touch 注入禁止); "引用"'
        result = self.run_cli("lead", str(self.repo), task)
        self.assertEqual(result.returncode, 0, result.stderr)
        calls = self.api_calls()
        self.assertEqual(len(calls), 3)
        self.assertEqual(calls[0], ["workspace", "create", "--cwd", str(self.repo),
                                   "--label", self.repo.name + " / lead", "--no-focus"])
        name = calls[1][2]
        self.assertRegex(name, r"^lead-[a-f0-9]{12}$")
        self.assertEqual(calls[1], ["agent", "start", name, "--kind", "codex",
                                   "--pane", "w31:p99", "--", "--no-alt-screen",
                                   "--cd", str(self.repo), "--add-dir",
                                   str(self.root / ".worktrees" / self.repo.name)])
        self.assertEqual(calls[2][:3], ["agent", "prompt", name])
        self.assertEqual(len(calls[2]), 4)
        for text in (task, self.base, str(ROOT / "prompts/orchestrator.md"), "worktree", "許可"):
            self.assertIn(text, calls[2][3])
        self.assertIn("w31:p99", result.stdout)
        self.assertFalse((self.repo / "注入禁止").exists())

    def test_outside_herdr(self):
        self.env.pop("HERDR_ENV")
        result = self.run_cli("lead", str(self.repo))
        self.assertNotEqual(result.returncode, 0)
        self.assertIn("Herdr内", result.stderr)
        self.assertEqual(self.calls(), [])

    def test_doctor(self):
        self.env.pop("HERDR_ENV")
        result = self.run_cli("doctor")
        self.assertNotEqual(result.returncode, 0)
        self.assertIn("0.9.5", result.stdout)
        self.assertIn("Herdr内", result.stdout)
        self.assertEqual(self.api_calls(), [])

    def test_old_herdr(self):
        self.env["FAKE_VERSION"] = "0.8.0"
        result = self.run_cli("lead", str(self.repo))
        self.assertNotEqual(result.returncode, 0)
        self.assertIn("0.9.5", result.stderr)
        self.assertEqual(self.api_calls(), [])

    def test_not_a_repo(self):
        result = self.run_cli("lead", str(self.root))
        self.assertNotEqual(result.returncode, 0)
        self.assertEqual(self.api_calls(), [])

    def test_failed_start(self):
        self.env["FAIL_START"] = "1"
        result = self.run_cli("lead", str(self.repo))
        self.assertNotEqual(result.returncode, 0)
        self.assertEqual([call[:2] for call in self.api_calls()],
                         [["workspace", "create"], ["agent", "start"]])
        self.assertIn("w31:p99", result.stderr)
        self.assertIn("保持", result.stderr)

    def test_failed_prompt(self):
        self.env["FAIL_PROMPT"] = "1"
        result = self.run_cli("lead", str(self.repo))
        self.assertNotEqual(result.returncode, 0)
        self.assertEqual(len(self.api_calls()), 3)
        self.assertIn("再送", result.stderr)

    def test_invalid_response(self):
        self.env["FAKE_CREATE"] = '{"ok": true, "result": {}}'
        result = self.run_cli("lead", str(self.repo))
        self.assertNotEqual(result.returncode, 0)
        self.assertEqual(len(self.api_calls()), 1)
        self.assertIn("workspace list", result.stderr)

    def test_malformed_ids(self):
        self.env["FAKE_CREATE"] = '{"result": {"workspace": null, "root_pane": []}}'
        result = self.run_cli("lead", str(self.repo))
        self.assertNotEqual(result.returncode, 0)
        self.assertNotIn("Traceback", result.stderr)
        self.assertIn("保持", result.stderr)
        self.assertEqual(len(self.api_calls()), 1)

    def test_no_initial_commit(self):
        empty = self.root / "初回コミットなし"
        subprocess.run(["git", "init", "--quiet", str(empty)], check=True)
        result = self.run_cli("lead", str(empty))
        self.assertNotEqual(result.returncode, 0)
        self.assertEqual(self.api_calls(), [])

    def test_dirty_repo_is_preserved(self):
        untracked = self.repo / "作業中.txt"
        untracked.write_text("未コミットの作業", encoding="utf-8")
        result = self.run_cli("lead", str(self.repo))
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(untracked.read_text(encoding="utf-8"), "未コミットの作業")
        self.assertEqual(subprocess.check_output(
            ["git", "-C", str(self.repo), "rev-parse", "HEAD"], text=True).strip(), self.base)

    def test_multiple_leads(self):
        for _ in range(2):
            result = self.run_cli("lead", str(self.repo))
            self.assertEqual(result.returncode, 0, result.stderr)
        starts = [call for call in self.api_calls() if call[:2] == ["agent", "start"]]
        self.assertEqual(len(starts), 2)
        self.assertNotEqual(starts[0][2], starts[1][2])


if __name__ == "__main__":
    unittest.main()
