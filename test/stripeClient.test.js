import test from "node:test";
import assert from "node:assert/strict";
import {
  createStripeClient,
  stripeKeyMode,
} from "../src/payments/stripeClient.js";

// Synthetic, non-functional values. No real Stripe credential is used.
const FAKE_TEST_KEY = "sk_test_" + "notarealkey".repeat(3);
const FAKE_LIVE_KEY = "sk_live_" + "notarealkey".repeat(3);
const FAKE_WEBHOOK_SECRET = "whsec_" + "notarealsecret".repeat(3);
const PAYLOAD = Buffer.from('{"id":"evt_fake"}');
const SIGNATURE = "t=1,v1=fake";

class FakeStripeSDK {
  constructor(apiKey) {
    this.apiKey = apiKey;
    this.constructEventCalls = [];
    this.webhooks = {
      constructEvent: (payload, signature, secret) => {
        this.constructEventCalls.push({ payload, signature, secret });
        return { id: "evt_fake", type: "checkout.session.completed" };
      },
    };
  }
}

test("detects Stripe key mode without calling Stripe", () => {
  assert.equal(stripeKeyMode(FAKE_TEST_KEY), "test");
  assert.equal(stripeKeyMode(FAKE_LIVE_KEY), "live");
  assert.equal(stripeKeyMode("pk_test_fake"), null);
  assert.equal(stripeKeyMode(undefined), null);
});

test("requires a valid server-side secret key", () => {
  assert.throws(
    () => createStripeClient({ StripeSDK: FakeStripeSDK }),
    { code: "PAYMENT_NOT_CONFIGURED", status: 503 },
  );
  assert.throws(
    () => createStripeClient({ secretKey: "pk_test_fake", StripeSDK: FakeStripeSDK }),
    { code: "PAYMENT_NOT_CONFIGURED", status: 503 },
  );
});

test("rejects an invalid webhook secret format", () => {
  assert.throws(
    () => createStripeClient({ secretKey: FAKE_TEST_KEY, webhookSecret: "bad", StripeSDK: FakeStripeSDK }),
    { code: "PAYMENT_NOT_CONFIGURED", status: 503 },
  );
});

test("creates exactly one injected client and never exposes the webhook secret", () => {
  const wrapper = createStripeClient({
    secretKey: `  ${FAKE_TEST_KEY}  `,
    webhookSecret: `  ${FAKE_WEBHOOK_SECRET}  `,
    StripeSDK: FakeStripeSDK,
  });

  assert.equal(wrapper.mode, "test");
  assert.equal(wrapper.hasWebhookSecret, true);
  assert.ok(wrapper.client instanceof FakeStripeSDK);
  assert.equal(wrapper.client.apiKey, FAKE_TEST_KEY);
  assert.equal(Object.isFrozen(wrapper), true);

  const serialized = JSON.stringify(Object.keys(wrapper));
  assert.equal(serialized.includes(FAKE_WEBHOOK_SECRET), false);
  assert.equal(Object.keys(wrapper).includes("secretKey"), false);
  assert.equal(Object.keys(wrapper).includes("webhookSecret"), false);

  assert.throws(() => { wrapper.mode = "live"; }, TypeError);
});

test("constructWebhookEvent forwards raw payload and signature with the hidden secret", () => {
  const wrapper = createStripeClient({
    secretKey: FAKE_TEST_KEY,
    webhookSecret: FAKE_WEBHOOK_SECRET,
    StripeSDK: FakeStripeSDK,
  });

  const event = wrapper.constructWebhookEvent(PAYLOAD, SIGNATURE);
  assert.equal(event.id, "evt_fake");
  assert.deepEqual(wrapper.client.constructEventCalls, [{
    payload: PAYLOAD,
    signature: SIGNATURE,
    secret: FAKE_WEBHOOK_SECRET,
  }]);
});

test("constructWebhookEvent fails explicitly when no webhook secret is configured", () => {
  const wrapper = createStripeClient({ secretKey: FAKE_TEST_KEY, StripeSDK: FakeStripeSDK });

  assert.equal(wrapper.hasWebhookSecret, false);
  assert.throws(
    () => wrapper.constructWebhookEvent(PAYLOAD, SIGNATURE),
    { code: "PAYMENT_NOT_CONFIGURED", status: 503 },
  );
  assert.equal(wrapper.client.constructEventCalls.length, 0);
});
