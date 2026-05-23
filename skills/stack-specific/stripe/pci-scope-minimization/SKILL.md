---
name: stripe-pci-scope-minimization
description: Minimize PCI DSS scope when integrating Stripe -- token-only flows (Elements, Checkout, PaymentSheet), avoid raw PAN handling, audit-log discipline for cardholder-data adjacencies. References PCI DSS v4 Requirement 3 (Protect Stored Account Data) and Requirement 10 (Log and Monitor Access). Triggers on Stripe payment-intent / charge / customer code authoring. OWASP ASI03 (Identity & Privilege Abuse) defense for PCI-scoped credential handling.
---

# Stripe PCI Scope Minimization

> Phase 2 Step 4 scaffold. Skill body is authored in session 4 batch 2.
> See `specs/phase-2/D-stack-specific-skills.md` REQ-D1 through REQ-D7 for
> the requirement bar this skill satisfies.
