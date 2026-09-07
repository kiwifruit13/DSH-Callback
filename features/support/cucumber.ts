/**
 * cucumber CJS 实例 shim（阶段 F 修复）。
 *
 * 背景：Windows + tsx 组合下，ESM `import '@cucumber/cucumber'`（wrapper.mjs
 * → CJS index.js 被 tsx 转译）与 cucumber API 内部的 CJS require 链会产生
 * 双实例，support 文件的 Given/When/Then 落在未初始化实例上，触发
 * "calling functions ... isn't running (status: PENDING)"。
 *
 * 解法：统一用 createRequire 走 CJS require 链拿实例 —— 与
 * @cucumber/cucumber/api 内部加载的实例相同。所有 support / steps 文件
 * 一律从本 shim 导入 cucumber 符号，禁止直接 import '@cucumber/cucumber'。
 */

import { createRequire } from 'node:module';

const requireCjs = createRequire(import.meta.url);

const cucumber = requireCjs('@cucumber/cucumber') as typeof import('@cucumber/cucumber');

export const After = cucumber.After;
export const AfterAll = cucumber.AfterAll;
export const AfterStep = cucumber.AfterStep;
export const Before = cucumber.Before;
export const BeforeAll = cucumber.BeforeAll;
export const BeforeStep = cucumber.BeforeStep;
export const DataTable = cucumber.DataTable;
export const Given = cucumber.Given;
export const Then = cucumber.Then;
export const When = cucumber.When;
export const World = cucumber.World;
export const defineParameterType = cucumber.defineParameterType;
export const defineStep = cucumber.defineStep;
export const setDefaultTimeout = cucumber.setDefaultTimeout;
export const setWorldConstructor = cucumber.setWorldConstructor;
export const setDefinitionFunctionWrapper = cucumber.setDefinitionFunctionWrapper;
export const setParallelCanAssign = cucumber.setParallelCanAssign;
export const supportCodeLibraryBuilder = cucumber.supportCodeLibraryBuilder;
