---
name: stripe-pci-scope-minimization
description: Minimize PCI DSS scope when integrating Stripe -- token-only flows (Elements, Checkout, PaymentSheet), avoid raw PAN handling, audit-log discipline for cardholder-data adjacencies. References PCI DSS v4 Requirement 3 (Protect Stored Account Data) and Requirement 10 (Log and Monitor Access). Triggers on Stripe payment-intent / charge / customer code authoring. OWASP ASI03 (Identity & Privilege Abuse) defense for PCI-scoped credential handling.
---

# Stripe PCI Scope Minimization

> Defends against **OWASP ASI03 (Identity & Privilege Abuse)** in the
> PCI-scoped credential dimension. PCI DSS classifies any system that
> processes, stores, or transmits cardholder data as "in scope" for full
> PCI compliance; "in scope" means a 12-requirement audit surface with
> teeth. The patterns here keep the application OUT of scope wherever
> possible -- token-only flows where Stripe-hosted UI handles raw card
> data, and tight discipline on the few places card-related data crosses
> the application boundary.

**Tradeoff:** Token-only flows give up some UX flexibility (Stripe's
Elements / Checkout / PaymentSheet host the card-data UI on Stripe's
domain). The benefit: the bulk of PCI DSS v4 requirements don't apply
to a SAQ-A integration where the app never sees a primary account number
(PAN). Self-hosted card data collection means SAQ-D scope: 200+ pages of
audit checklist.

---

## Why this matters

PCI DSS v4.0 (released March 2022; v4.0.1 minor revision June 2024)
defines four merchant-level SAQs (Self-Assessment Questionnaires):

- **SAQ-A**: e-commerce merchants who fully outsource cardholder-data
  handling to a PCI-DSS-validated third party. Smallest scope.
- **SAQ-A-EP**: e-commerce where the merchant's site loads the
  card-collection UI but doesn't see the card data itself.
- **SAQ-D-Merchant**: merchants who handle PAN themselves.
- **SAQ-D-Service-Provider**: for SaaS that processes card data on
  behalf of others.

Stripe's hosted flows (Checkout, PaymentSheet, Payment Element with
client-side `confirmCardPayment`) keep most integrations in SAQ-A.
The moment the application reads, stores, or transmits raw card data
-- even briefly, even in memory -- scope balloons.

---

## Pattern 1 -- Use Stripe's hosted card-collection UI

The card-data UI runs on Stripe's domain (via iframes or hosted-page
redirects). The application receives back a tokenized identifier (a
`PaymentMethod` id, format `pm_...`, or a `PaymentIntent` id `pi_...`)
that references the card on Stripe's side. The PAN never reaches the
application.

```ts
// Server: create a PaymentIntent that the client will confirm.
const pi = await stripe.paymentIntents.create({
  amount: 1999,
  currency: 'usd',
  customer: customerId,
  automatic_payment_methods: { enabled: true },
});

// Client: confirm using Stripe.js (loads from stripe.com -- iframed
// PCI-scoped UI on Stripe's domain). The page never touches raw PAN.
const result = await stripe.confirmCardPayment(pi.client_secret, {
  payment_method: {
    card: cardElement,  // Stripe.js managed element, scoped to Stripe's domain
    billing_details: { name: 'NAME REDACTED' },
  },
});
```

After confirmation, the application stores ONLY the `PaymentIntent.id`
or `PaymentMethod.id`. These tokens are useless to an attacker who
breaches the application database; they only function with the Stripe
secret key.

---

## Pattern 2 -- Never log card data, ever

PCI DSS v4 **Requirement 3 -- Protect Stored Account Data** restricts
storage of full PAN, sensitive authentication data (SAD: CVV, full
track data, PIN blocks), and similar. **Sensitive authentication data
SHALL NOT be stored after authorization, even if encrypted.**
**Requirement 10 -- Log and Monitor All Access** also imposes
restrictions on what audit logs may contain about cardholder data.

The simplest interpretation: do not log card-related fields. If a
log line happens to contain a PaymentIntent object from a Stripe API
response, redact the `payment_method` details before serializing.

```ts
// Redact card-related fields before logging.
function redactCardData<T extends { payment_method?: unknown; charges?: unknown }>(obj: T): T {
  const copy = JSON.parse(JSON.stringify(obj)) as T;
  if (copy.payment_method) {
    copy.payment_method = '[REDACTED]' as never;
  }
  if (copy.charges && typeof copy.charges === 'object') {
    // ... recursively redact charge.payment_method_details ...
  }
  return copy;
}

console.log('payment intent processed', redactCardData(paymentIntent));
```

This applies to error paths too -- a try / catch that logs an Error
whose `.message` contains the raw API response leaks the card details
into log storage. Use Stripe error subtypes (`Stripe.errors.*`) and log
only `err.code` + `err.type`, never the full error object.

---

## Pattern 3 -- Restrict who has access to the Stripe secret key

PCI DSS v4 **Requirement 7 -- Restrict Access to System Components**
applies to systems that touch the cardholder-data environment (CDE);
the Stripe secret key is one such credential. Discipline:

- The secret key lives in a vault (1Password, AWS Secrets Manager,
  HashiCorp Vault, Doppler), never in `.env.local` committed to git
  and never in a CI config file in plain text.
- Production secret key is distinct from test secret key
  (`sk_live_*` vs `sk_test_*`); the test key never grants access to
  live cardholder data.
- The set of engineers with production-secret-key access is auditable
  per **Requirement 10**: when an engineer joins / leaves a team with
  CDE access, the access change is logged in an auditable system.
- Server processes load the key at boot from the vault; no human reads
  it in cleartext during normal operations.

---

## Anti-patterns

### Anti-pattern 1 -- Accepting raw card data via the application's own API

```ts
// WRONG
app.post('/api/checkout', async (req, res) => {
  const { cardNumber, cvv, expMonth, expYear } = req.body;
  const charge = await stripe.charges.create({ source: { number: cardNumber, ... } });
  // ...
});
```

This single endpoint pulls the entire application into SAQ-D scope. The
application now processes, transmits, AND (depending on logging) stores
PAN. Use the Stripe.js client-side tokenization (Pattern 1) instead --
the client sends a tokenized `PaymentMethod` id to the server, never the
raw card.

### Anti-pattern 2 -- Logging full Stripe API responses without redaction

```ts
// WRONG
const charge = await stripe.charges.create({ ... });
logger.info('charge created', charge);  // contains card.last4, card.brand, billing_details
```

Even partial card data (last4, brand) plus billing_details (name, address)
in logs creates an audit problem -- log retention, access control, and
backup discipline all become CDE concerns per Requirement 3 + 10. Redact
at the logging boundary (Pattern 2).

### Anti-pattern 3 -- Sharing the secret key across environments

```bash
# WRONG: same key for staging and production
export STRIPE_SECRET_KEY=sk_live_AbCdEf...
```

Production and staging secret keys MUST be distinct. Sharing makes
staging access equivalent to production access for cardholder-data
purposes; a staging-environment compromise becomes a production-scope
incident. PCI DSS v4 Requirement 6 + 7 imply isolation between
environments for CDE-adjacent credentials.

---

## ASI/AST mapping

This skill addresses **canonical OWASP ASI03 (Identity & Privilege
Abuse)** from `governance/owasp-asi-2026/threats.md` in the
PCI-credential dimension. The Stripe secret key is a high-privilege
credential whose misuse moves money and exposes cardholder data. The
patterns here -- keep the credential out of the application's regular
runtime surface, restrict the human + service identities that hold it,
audit access -- are the ASI03 defense for this specific credential
class.

The Stripe webhook idempotency skill
(`stack-specific/stripe/webhook-idempotency`) is the ASI02 counterpart
for the same Stripe integration.

---

## PCI DSS v4 section references

Operators implementing this skill SHALL verify the exact subsection
numbers against the current PCI DSS v4.0.1 standard text
(https://www.pcisecuritystandards.org/) -- subsection numbering has
been stable across the v4.0 → v4.0.1 minor revision but a future v4.x
release may renumber. The references in this skill are at the
Requirement level (3, 6, 7, 10), which has been stable across the entire
v4.x family:

- **Requirement 3 -- Protect Stored Account Data**: drives Pattern 2
  (no logging card data) and the no-PAN-storage default.
- **Requirement 6 -- Develop and Maintain Secure Systems and Software**:
  implies environment isolation (Anti-pattern 3).
- **Requirement 7 -- Restrict Access to System Components and Cardholder
  Data**: drives Pattern 3 (restrict secret-key access).
- **Requirement 10 -- Log and Monitor All Access**: drives Pattern 2 +
  Pattern 3 (auditable secret-key access).

---

## Testing

Concrete checks an SAQ-A integration should pass:

- `grep -ri 'cardNumber\|pan\|cvv' src/` returns no results (no raw card
  fields in application source).
- Stripe API responses are redacted before reaching any log destination
  -- check via a synthetic-event integration test.
- Secret key is loaded from vault at boot, not from `.env` or repo
  config.
- Staging and production secret keys are distinct (compare `sk_live_*`
  prefix presence between environments).

---

## See also

- `governance/owasp-asi-2026/threats.md` -- ASI03 full text
- PCI DSS v4.0.1 standard:
  https://www.pcisecuritystandards.org/document_library/?category=pcidss
- Stripe PCI guidance:
  https://stripe.com/docs/security/guide
- `skills/stack-specific/stripe/webhook-idempotency/SKILL.md` -- the
  ASI02 companion skill for the same Stripe integration
