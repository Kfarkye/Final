import { assertFails, assertSucceeds, initializeTestEnvironment } from "@firebase/rules-unit-testing";
import { readFileSync } from "fs";
import { describe, it, beforeAll as before, afterAll as after, beforeEach, assert } from "vitest";

const runFirestoreTests = process.env.FIRESTORE_EMULATOR_HOST !== undefined || process.env.CI !== undefined;

describe.skipIf(!runFirestoreTests)("Reverie Security Rules", () => {
  let testEnv;

  before(async () => {
    // Only initialize if we are actually running the tests
    if (!runFirestoreTests) return;
    testEnv = await initializeTestEnvironment({
      projectId: "demo-project-test",
      firestore: {
        rules: readFileSync("firestore.rules", "utf8"),
        host: "localhost",
        port: 8080
      },
    });
  });

  beforeEach(async () => {
    if (testEnv) await testEnv.clearFirestore();
  });

  after(async () => {
    if (testEnv) await testEnv.cleanup();
  });

  it("P1 (Shadow Tier Update) should fail", async () => {
    const db = testEnv.authenticatedContext("user1", { email_verified: true }).firestore();
    const ref = db.collection("users").doc("user1");
    await assertFails(ref.update({ tier: "annual_plus" }));
  });

  it("P2 (Identity Spoofing) read other profile should fail", async () => {
    const db1 = testEnv.authenticatedContext("user1", { email_verified: true }).firestore();
    const ref2 = db1.collection("users").doc("user2");
    await assertFails(ref2.get());
  });
});
