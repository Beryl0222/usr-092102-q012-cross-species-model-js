import { appendFileSync, existsSync, readFileSync } from "node:fs";
import { randomUUID } from "node:crypto";

import { validateEvent } from "../validator.js";

export class ConcurrencyError extends Error {
  constructor(expected, actual) {
    super(`聚合流版本冲突：期望 ${expected}，实际 ${actual}`);
    this.name = "ConcurrencyError";
    this.expected = expected;
    this.actual = actual;
  }
}

export class ValidationError extends Error {
  constructor(errors) {
    super(`事件校验失败：\n - ${errors.join("\n - ")}`);
    this.name = "ValidationError";
    this.errors = errors;
  }
}

export class DuplicateIdempotencyError extends Error {
  constructor(existingEvent) {
    super(`幂等键 ${existingEvent.idempotency_key} 已存在于事件 ${existingEvent.event_id}`);
    this.name = "DuplicateIdempotencyError";
    this.existingEvent = existingEvent;
  }
}

export const streamKey = (aggregateType, aggregateId) => `${aggregateType}/${aggregateId}`;

/**
 * 追加式事件存储。
 * - 每个聚合流维护单调 version（乐观并发）；
 * - idempotency_key 全局去重：重复回调返回原事件，绝不产生第二个运行；
 * - 可选 JSONL 持久化：进程重启后完整重放历史（撤回只追加标记，历史仍可复查）。
 */
export class EventStore {
  /** @param {string} [file] 不传则仅内存（测试用）。 */
  constructor(file) {
    this.file = file;
    /** @type {Array<object>} 全局事件日志，按提交顺序。 */
    this.events = [];
    /** @type {Map<string, object[]>} 流键 -> 事件 */
    this.streams = new Map();
    /** @type {Map<string, object>} idempotency_key -> 已存在事件 */
    this.idempotency = new Map();
    if (file && existsSync(file)) this._load();
  }

  _load() {
    const text = readFileSync(this.file, "utf8").trim();
    if (!text) return;
    for (const line of text.split("\n")) {
      if (!line.trim()) continue;
      const event = JSON.parse(line);
      this._index(event, { replay: true });
    }
  }

  _index(event, { replay }) {
    const key = streamKey(event.aggregate_type, event.aggregate_id);
    const list = this.streams.get(key) ?? [];
    list.push(event);
    this.streams.set(key, list);
    this.events.push(event);
    if (event.idempotency_key) this.idempotency.set(event.idempotency_key, event);
    if (!replay && this.file) appendFileSync(this.file, JSON.stringify(event) + "\n");
  }

  /**
   * 提交一条事件。
   * @param {object} input 已满足信封的事件；event_id/occurred_at/version 可省略，由存储补齐。
   * @param {{expectedVersion?: number}} [opts]
   * @returns {{event: object, duplicate: boolean}}
   */
  append(input, opts = {}) {
    const key = input.aggregate_type && input.aggregate_id ? streamKey(input.aggregate_type, input.aggregate_id) : null;

    // 幂等：相同 idempotency_key 的重复投递直接返回首次事件（训练回调重放路径）。
    if (input.idempotency_key && this.idempotency.has(input.idempotency_key)) {
      return { event: this.idempotency.get(input.idempotency_key), duplicate: true };
    }

    const currentVersion = key ? (this.streams.get(key)?.length ?? 0) : 0;
    if (opts.expectedVersion !== undefined && opts.expectedVersion !== currentVersion) {
      throw new ConcurrencyError(opts.expectedVersion, currentVersion);
    }

    const event = {
      occurred_at: new Date().toISOString(),
      ...input,
      event_id: input.event_id ?? randomUUID(),
      version: input.version ?? currentVersion + 1,
    };

    const errors = validateEvent(event);
    if (errors.length) throw new ValidationError(errors);

    this._index(event, { replay: false });
    return { event, duplicate: false };
  }

  readStream(aggregateType, aggregateId) {
    return [...(this.streams.get(streamKey(aggregateType, aggregateId)) ?? [])];
  }

  streamVersion(aggregateType, aggregateId) {
    return this.streams.get(streamKey(aggregateType, aggregateId))?.length ?? 0;
  }

  allEvents() {
    return [...this.events];
  }
}
