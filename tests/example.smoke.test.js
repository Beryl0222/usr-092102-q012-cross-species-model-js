import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import test from "node:test";

test("端到端示例场景全部策略检查通过", () => {
  const script = fileURLToPath(new URL("../examples/cross-species-figure.js", import.meta.url));
  let stdout;
  try {
    stdout = execFileSync(process.execPath, [script], { encoding: "utf8" });
  } catch (error) {
    assert.fail(`示例脚本失败退出：\n${error.stdout ?? ""}\n${error.stderr ?? error.message}`);
  }
  const match = stdout.match(/场景检查：(\d+)\/(\d+) 通过/);
  assert.ok(match, `示例未输出检查统计：\n${stdout}`);
  assert.equal(match[1], match[2], `存在失败检查：\n${stdout}`);
  assert.match(stdout, /29\/29/);
});
