import test from "node:test";
import assert from "node:assert/strict";
import { sanitizeSettings } from "../extension/shared/storage.js";

test("reflection wait settings migrate away from fixed chat turns", () => {
  const settings = sanitizeSettings({
    sitePolicy: {
      minimumChatTurns: 5,
      conflictWaitBaseSeconds: 30,
      conflictWaitMaxSeconds: 10
    }
  });

  assert.equal("minimumChatTurns" in settings.sitePolicy, false);
  assert.equal(settings.sitePolicy.conflictWaitBaseSeconds, 30);
  assert.equal(settings.sitePolicy.conflictWaitMaxSeconds, 30);
});

test("reflection waits retain the 15 and 120 second defaults", () => {
  const settings = sanitizeSettings({});
  assert.equal(settings.sitePolicy.conflictWaitBaseSeconds, 15);
  assert.equal(settings.sitePolicy.conflictWaitMaxSeconds, 120);
});
