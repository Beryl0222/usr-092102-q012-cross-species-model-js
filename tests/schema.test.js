import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import { AGGREGATE_TYPES, EVENT_TYPES } from "../src/domain.js";

test("schema 文件可解析且信封枚举与运行时常量一致（防止契约与代码漂移）", async () => {
  const schema = JSON.parse(await readFile(new URL("../contracts/domain.schema.json", import.meta.url), "utf8"));
  const eventEnum = schema.properties.event_type.enum;
  const aggEnum = schema.properties.aggregate_type.enum;
  assert.deepEqual([...eventEnum].sort(), [...EVENT_TYPES].sort());
  assert.deepEqual([...aggEnum].sort(), [...AGGREGATE_TYPES].sort());

  // 每个事件类型都必须有对应的条件分支（或显式共用分支）
  const branchTypes = new Set();
  for (const clause of schema.allOf) {
    const t = clause.if?.properties?.event_type;
    const values = t?.enum ?? [t?.const];
    for (const v of values) if (v) branchTypes.add(v);
  }
  for (const t of EVENT_TYPES) assert.ok(branchTypes.has(t), `schema 缺少 ${t} 的负载分支`);
});
