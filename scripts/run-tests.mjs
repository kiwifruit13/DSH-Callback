/**
 * 测试运行入口（阶段 F 修复）：规避 Windows 盘符大小写导致的 cucumber 双实例。
 *
 * 问题：npm 在 Git Bash 环境下以小写盘符 cwd（如 d:\...）启动 node，CLI 内部
 * CJS require 链的缓存键带小写盘符；而 support 步骤文件经 pathToFileURL 动态
 * ESM 导入（盘符被强制大写 D:\...），其内部 require('@cucumber/cucumber') 的
 * 缓存键带大写盘符。Windows 的 require.cache 键大小写敏感 → 同一文件被实例化
 * 两次 → 步骤文件里的 Given/When/Then 落在未 reset 的实例上，报
 * "calling functions ... isn't running (status: PENDING)"。
 *
 * 解法：用 fs.realpathSync 取真实磁盘大小写加载 cucumber 与 cwd，
 * 使 CJS 缓存键与 ESM 侧（pathToFileURL 大写盘符 + 真实路径）一致 → 单实例。
 */

import fs from 'node:fs';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);

/**
 * Windows 路径盘符规范化：统一大写。
 * 注意 fs.realpathSync 会保留输入的盘符大小写，无法用于规范化，
 * 因此手动把 "d:" / "D:" 统一为大写 "D:"。
 */
function normalizeWinPath(p) {
  return p.replace(/^([a-zA-Z]):/, (_m, drive) => drive.toUpperCase() + ':');
}

const cucumberEntry = normalizeWinPath(fs.realpathSync(require.resolve('@cucumber/cucumber')));
const { Cli } = require(cucumberEntry);

const cli = new Cli({
  argv: process.argv,
  cwd: normalizeWinPath(fs.realpathSync(process.cwd())),
  stdout: process.stdout,
  stderr: process.stderr,
  env: process.env,
});

let result;
try {
  result = await cli.run();
} catch (error) {
  console.error(error);
  process.exit(1);
}

process.exitCode = result.success ? 0 : 1;
if (result.shouldExitImmediately) {
  process.exit(process.exitCode);
}
