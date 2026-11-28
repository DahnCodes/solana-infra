import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  emptyForm,
  percentToBps,
  toConfigArgs,
  toLimiterArgs,
  validate,
  type RegisterForm,
} from "./form-model.ts";

const A = "AiMhNgDgXLQ68FhZrYczUiGxDxDeDxNFDTurqNFPP5kB";
const B = "2orgNn8kfHVQi8EMxa86zntq8BbwQefXPtpZiQTfgPyn";
const C = "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA";
const D = "EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG";

function filled(): RegisterForm {
  const form = emptyForm();
  form.program = A;
  form.guardians = [B];
  form.unpausable = [3];
  form.timelockHours = "36";
  Object.assign(form.limiters[0], {
    mint: C,
    vault: D,
    cap: "150,000",
    capPercent: "15",
    threshold: "100000",
    thresholdPercent: "5",
  });
  return form;
}

describe("register form", () => {
  it("accepts a complete form and builds the instruction arguments", () => {
    const form = filled();
    assert.deepEqual(validate(form), {});
    const config = toConfigArgs(form, B);
    assert.equal(config.timelockSecs, 36 * 3600);
    assert.equal(config.unpausableMask, BigInt(8));
    assert.deepEqual(config.guardians, [B]);
    assert.equal(config.admin, B, "an empty admin is the connected wallet");
    assert.equal(toConfigArgs({ ...form, admin: ` ${D} ` }, B).admin, D);
    assert.ok(validate({ ...form, admin: "nope" }).admin);
    const limiter = toLimiterArgs(form.limiters[0], "cfg");
    assert.equal(limiter.capAbsolute, BigInt(150_000_000_000));
    assert.equal(limiter.capBpsOfVault, 1500);
    assert.equal(limiter.largeThresholdBps, 500);
    assert.equal(limiter.windowSecs, 3600);
    assert.equal(limiter.holdSecs, 6 * 3600);
    assert.equal(limiter.instantAllowance, null);
  });

  it("flags each bad field with a reason", () => {
    const form = filled();
    form.program = "not-an-address";
    form.guardians = [B, B];
    form.timelockHours = "12";
    form.limiters[0].scope = "3"; // always open
    form.limiters[0].cap = "0";
    form.limiters[0].capPercent = "150";
    const errors = validate(form);
    assert.ok(errors.program);
    assert.equal(errors["guardians.1"], "Already listed.");
    assert.ok(errors.timelockHours);
    assert.ok(errors["limiters.0.scope"]);
    assert.ok(errors["limiters.0.cap"]);
    assert.ok(errors["limiters.0.capPercent"]);
  });

  it("needs a guardian and a limiter, one per token", () => {
    const form = filled();
    form.guardians = [""];
    form.limiters.push({ ...form.limiters[0], id: 2 });
    const errors = validate(form);
    assert.ok(errors["guardians.0"]);
    assert.equal(
      errors["limiters.1.mint"],
      "This token already has a limiter.",
    );
  });

  it("turns screening on with a zero instant allowance", () => {
    const form = filled();
    form.limiters[0].screenAll = true;
    assert.equal(
      toLimiterArgs(form.limiters[0], "cfg").instantAllowance,
      BigInt(0),
    );
  });

  it("reads percentages as basis points", () => {
    assert.equal(percentToBps(""), 0);
    assert.equal(percentToBps("2.5"), 250);
    assert.equal(percentToBps("100"), 10_000);
    assert.equal(percentToBps("100.01"), null);
    assert.equal(percentToBps("1.234"), null);
  });
});
