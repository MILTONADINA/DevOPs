# SECURITY_POLICY.md — Vulnerability Disclosure Policy

## Reporting a Security Vulnerability

**Do not open a public GitHub issue for security vulnerabilities.**

Email: `security@startum.com`

Include in your report:
- Description of the vulnerability
- Steps to reproduce
- Potential impact
- Any proof-of-concept code (if applicable)

We will acknowledge receipt within **24 hours** and provide a status update within **72 hours**.

---

## Scope

### In Scope

The following are in scope for security reports:

- CQ proxy — authentication bypass, token injection, data exfiltration
- TEE / Nitro Enclave — attestation bypass, plaintext context exposure
- Billing engine — billing record manipulation, signing key compromise
- Memory stores — unauthorized data access across organizations
- API endpoints — authorization flaws, IDOR, injection vulnerabilities
- Client library — encryption weaknesses, key derivation flaws
- ZK-Context protocol — session key exposure, MITM vulnerabilities

### Out of Scope

- Vulnerabilities in third-party services (Supabase, Pinecone, Neo4j, Cloudflare, AWS) — report these to the respective vendors
- Denial of service via resource exhaustion (we do rate-limit; report bypass if found)
- Social engineering of CQ team members
- Vulnerabilities requiring physical access to customer devices
- Security issues in dependencies — report these to the dependency maintainer; notify us so we can expedite patching

---

## Our Commitments

**To researchers who report in good faith:**

- We will not pursue legal action against you for responsible disclosure
- We will credit you in the security advisory (unless you prefer anonymity)
- We will notify you when the vulnerability is patched
- We will communicate openly about our remediation timeline

**Our internal commitments:**

- Acknowledge receipt within 24 hours
- Provide a severity assessment within 72 hours
- For Critical/High issues: deploy a fix within 7 days
- For Medium issues: deploy a fix within 30 days
- For Low issues: address in the next scheduled release
- Notify affected customers within 72 hours of a confirmed breach (GDPR requirement)
- Publish a post-mortem within 30 days for any Critical issue

---

## Severity Classification

| Severity | Description | Example |
|---|---|---|
| Critical | Data breach or complete system compromise | Attestation bypass exposing raw customer context |
| High | Significant data exposure or privilege escalation | Cross-org memory access, billing record manipulation |
| Medium | Limited data exposure or functionality bypass | Token count underreporting, rate limit bypass |
| Low | Minor information disclosure or theoretical risk | Non-sensitive metadata exposure |

---

## Encryption Key Compromise

If you believe a signing key, master encryption key, or enclave private key has been compromised, treat this as Critical and use the subject line: `[CRITICAL-KEY] Startum Security`

We will:
1. Rotate all affected keys immediately
2. Invalidate all active sessions
3. Force re-attestation for all ZK-Context organizations
4. Notify all affected customers within 24 hours

---

## Safe Harbor

We consider security research conducted in accordance with this policy to be authorized. We will not take legal action against researchers who:

- Report vulnerabilities promptly and in good faith
- Do not access, modify, or delete customer data beyond what is necessary to demonstrate the vulnerability
- Do not exploit vulnerabilities for personal gain
- Do not disclose the vulnerability publicly before we have had a reasonable opportunity to fix it (90 days from acknowledgement)
