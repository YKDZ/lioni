import assert from "node:assert/strict";
import { test } from "node:test";

import { quantityProfile } from "../quantities/index.ts";
const en = quantityProfile("en", "en")!;
const zh = quantityProfile("zh-CN", "zh-CN")!;
const ja = quantityProfile("ja", "ja")!;

void test("数值算法按声明的语言选择，未知或错配能力不悄悄回退", () => {
  assert.equal(quantityProfile(undefined, "de-DE"), undefined);
  assert.equal(quantityProfile("en", "ja"), undefined);
  assert.equal(quantityProfile("zh-CN", "zh-TW"), undefined);
  assert.ok(quantityProfile("en", "en-GB"));
});

void test("中日文数词与单位换算共享比较事实，单位或负号变化保持可见", () => {
  assert.deepEqual(
    zh.facts("等待两秒", {}),
    en.facts("Wait 2000 milliseconds", {}),
  );
  assert.deepEqual(
    ja.facts("二秒待つ", {}),
    en.facts("Wait 2000 milliseconds", {}),
  );
  assert.deepEqual(
    ja.facts("１時間後", {}),
    en.facts("after 3600 seconds", {}),
  );
  assert.deepEqual(ja.facts("1024バイト", {}), en.facts("1 KiB", {}));
  assert.deepEqual(ja.facts("最大25,000件", {}), en.facts("Max 25000", {}));
  assert.notDeepEqual(ja.facts("最大250 00件", {}), en.facts("Max 25000", {}));
  assert.notDeepEqual(ja.facts("20分", {}), en.facts("20 seconds", {}));
  assert.notDeepEqual(ja.facts("1で無効化", {}), en.facts("-1 to disable", {}));
  assert.equal(ja.unitAfter("秒で処理", {}), en.unitAfter("seconds", {}));
  assert.notEqual(ja.unitAfter("分で処理", {}), en.unitAfter("seconds", {}));
});

void test("复发动作的一次不额外计数，速率与序数保持语言间对应", () => {
  assert.deepEqual(
    zh.facts("每30秒重试一次", {}),
    en.facts("Retry every 30 seconds", {}),
  );
  assert.deepEqual(
    ja.facts("30秒ごとに1回再試行", {}),
    en.facts("Retry every 30 seconds", {}),
  );
  assert.deepEqual(ja.facts("毎秒250件", {}), en.facts("250 per second", {}));
  assert.deepEqual(
    ja.facts("1時間あたり250件", {}),
    en.facts("250 per hour", {}),
  );
  assert.deepEqual(
    ja.facts("最後から2番目の日", {}),
    en.facts("2nd last day", {}),
  );
});

void test("项目字面例外只在显式提供时生效，并在日语宽度归一化前应用", () => {
  assert.deepEqual(
    zh.facts("二次验证一小时后过期", { ignoredLiterals: ["二次验证"] }),
    en.facts("2FA expires after 1 hour", { ignoredLiterals: ["2FA"] }),
  );
  assert.notDeepEqual(
    zh.facts("二次验证一小时后过期", {}),
    en.facts("2FA expires after 1 hour", { ignoredLiterals: ["2FA"] }),
  );
  assert.deepEqual(
    ja.facts("２段階認証は1時間後に期限切れ", {
      ignoredLiterals: ["２段階認証"],
    }),
    en.facts("2FA expires after 1 hour", { ignoredLiterals: ["2FA"] }),
  );
  assert.deepEqual(
    zh.facts("3分", { aliases: { 分: "分钟" } }),
    en.facts("180 seconds", {}),
  );
});
