# Threat Model — <Feature Name>

**Spec**: `specs/<path>.md`
**Date**: YYYY-MM-DD
**Author**: <user>
**Reviewer**: <user>
**Status**: draft | approved | needs-revision

---

## System sketch

```
<ASCII data flow diagram or describe in prose>

actors → entry points → trust boundaries → data stores → external systems
```

## Trust boundaries

> Every line crossing a boundary is an attack surface. Be explicit.

1. External clients → public API [TRUST BOUNDARY]
2. Public API → internal services [TRUST BOUNDARY]
3. Application → database [TRUST BOUNDARY]
4. Agent → tool [TRUST BOUNDARY]
5. Agent → external content (docs, RAG, web) [TRUST BOUNDARY — often missed]

## Data classes

| Class | Where stored | Where transmitted | Retention |
|-------|--------------|-------------------|-----------|
| Email | users.email column | TLS to MTA | until account deletion |
| ... | ... | ... | ... |

---

## STRIDE analysis

| Threat | Description | Mitigation | Implementation status |
|--------|-------------|------------|----------------------|
| **Spoofing** — can someone impersonate? | Auth-token forging | JWT signed with HS256/key rotation; refresh on each call | implemented |
| **Tampering** — can data be modified? | Request body modification | TLS in transit; HMAC on webhooks | implemented |
| **Repudiation** — can someone deny doing it? | User claims they didn't reset password | Append-only audit log with timestamps, IP, user-agent | spec'd |
| **Information disclosure** — can data leak? | PII in logs | Inline PII redaction at OTel exporter | implemented |
| **Denial of service** — can it be made unavailable? | Reset-flood attack | Rate limit 5 req/min/IP on /auth/reset | spec'd |
| **Elevation of privilege** — can someone become admin? | IDOR on user-update endpoint | Authorization checked per-resource, not per-endpoint | spec'd |

---

## OWASP Top 10 for Agentic Applications (ASI) 2026

| ID | Threat | Applicable? | Description | Mitigation | Status |
|----|--------|------------|-------------|------------|--------|
| ASI01 | Agent Goal Hijacking | yes/no | <how it could happen here> | <how prevented> | implemented / spec'd / open |
| ASI02 | Tool Misuse | | | | |
| ASI03 | Identity and Privilege Abuse | | | | |
| ASI04 | Indirect Prompt Injection | | | | |
| ASI05 | Memory Poisoning | | | | |
| ASI06 | Inter-agent Communication Attacks | | | | |
| ASI07 | Resource Exhaustion | | | | |
| ASI08 | Recursive Hijacking | | | | |
| ASI09 | Human-Agent Trust Exploitation | | | | |
| ASI10 | Rogue Agents | | | | |

---

## Open issues

> Block merge until resolved.

1. ...
2. ...

---

## Sign-off

- [ ] Engineer: <user> — <date>
- [ ] Security reviewer: <user> — <date>
- [ ] Red-team scan (`deepteam OWASP_ASI_2026()`): <link to claim artifact>
