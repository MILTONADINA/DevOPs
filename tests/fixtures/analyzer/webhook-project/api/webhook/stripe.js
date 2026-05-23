// tests/fixtures/analyzer/webhook-project/api/webhook/stripe.js
//
// Minimal Express webhook handler fixture for REQ-G6 AC-G6.1. The presence of
// the route path '/api/webhook/stripe' and the Stripe-Signature header
// reference are what the analyzer's detectWebhookIndicators() heuristic
// pattern-matches on. The handler logic is intentionally trivial -- this is a
// fixture, not a production webhook implementation.

const express = require('express');
const app = express();

app.post('/api/webhook/stripe', express.raw({ type: 'application/json' }), (req, res) => {
  const signature = req.headers['Stripe-Signature'];
  // Real handlers verify the signature and idempotency-key here. The
  // webhook-idempotency skill (skills/universal/security/webhook-idempotency)
  // teaches the proper pattern. This fixture skips the implementation; its
  // job is only to be detectable by the analyzer.
  void signature;
  res.status(200).send('ok');
});

module.exports = app;
