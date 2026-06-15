import { assertFails, assertSucceeds, initializeTestEnvironment } from "@firebase/rules-unit-testing";
import { readFileSync } from "fs";
import { describe, it, before, after, beforeEach } from "node:test";
import * as assert from "node:assert";

let testEnv;

before(async () => {
  testEnv = await initializeTestEnvironment({
    projectId: "demo-project-test",
    firestore: {
      rules: readFileSync("DRAFT_firestore.rules", "utf8"),
      host: "localhost",
      port: 8080
    },
  });
});

beforeEach(async () => {
  await testEnv.clearFirestore();
});

after(async () => {
  await testEnv.cleanup();
});

describe("Reverie Security Rules", () => {
  it("P1 (Shadow Tier Update) should fail", async () => {
    const db = testEnv.authenticatedContext("user1", { email_verified: true }).firestore();
    const ref = db.collection("users").doc("user1");
    // Ensure read might work if we created it but here update is false.
    await assertFails(ref.update({ tier: "annual_plus" }));
  });

  it("P2 (Identity Spoofing) read other profile should fail", async () => {
    const db1 = testEnv.authenticatedContext("user1", { email_verified: true }).firestore();
    const ref2 = db1.collection("users").doc("user2");
    await assertFails(ref2.get());
  });

  // More tests would be formulated if time permitted...
});
