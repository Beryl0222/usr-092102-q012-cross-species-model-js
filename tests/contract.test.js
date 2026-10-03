import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import {
  AGGREGATE_TYPES,
  EVENT_AGGREGATE_RULES,
  EVENT_TYPES,
  VALIDATION_LEVELS,
  domainEventFields,
} from "../src/domain.js";
import { validateEvent } from "../src/validator.js";

const schema = JSON.parse(
  await readFile(new URL("../contracts/domain.schema.json", import.meta.url), "utf8")
);
const sample = JSON.parse(
  await readFile(new URL("../data/sample.json", import.meta.url), "utf8")
);

test("样例符合领域约定", () => {
  assert.deepEqual(validateEvent(sample), []);
});

test("schema 必填字段与 JS 信封字段一致（payload 为必填）", () => {
  for (const field of domainEventFields) {
    assert.ok(schema.required.includes(field), `schema 缺少必填字段 ${field}`);
  }
  assert.deepEqual([...schema.required].sort(), [...domainEventFields].sort());
});

test("JS 事件枚举与 schema 不漂移", () => {
  assert.deepEqual(
    [...new Set(Object.values(EVENT_TYPES))].sort(),
    [...schema.properties.event_type.enum].sort()
  );
});

test("JS 聚合枚举与 schema 不漂移", () => {
  assert.deepEqual(
    [...new Set(Object.values(AGGREGATE_TYPES))].sort(),
    [...schema.properties.aggregate_type.enum].sort()
  );
});

test("事件→聚合规则与 schema allOf 分支一一对应", () => {
  const schemaRules = schema.allOf.map((branch) => {
    const eventType = branch.if.properties.event_type.const;
    const aggregate = branch.then.properties.aggregate_type;
    const aggregates = aggregate.const ? [aggregate.const] : aggregate.enum;
    return [eventType, [...aggregates].sort()];
  });
  for (const [eventType, aggregates] of schemaRules) {
    assert.deepEqual(
      [...EVENT_AGGREGATE_RULES[eventType]].sort(),
      aggregates,
      `${eventType} 的聚合规则与 schema 不一致`
    );
  }
  assert.equal(schemaRules.length, Object.keys(EVENT_AGGREGATE_RULES).length);
});

test("验证等级词表与 schema $defs 一致", () => {
  const schemaLevels = schema.$defs.validation_level.enum;
  assert.deepEqual([...new Set(Object.values(VALIDATION_LEVELS))].sort(), [...schemaLevels].sort());
});

test("每个事件类型在 schema 中都有 if/then 载荷分支", () => {
  const covered = schema.allOf.map((branch) => branch.if.properties.event_type.const).sort();
  assert.deepEqual(covered, Object.values(EVENT_TYPES).sort());
});
