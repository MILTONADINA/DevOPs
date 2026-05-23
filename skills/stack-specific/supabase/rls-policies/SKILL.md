---
name: supabase-rls-policies
description: Supabase Row-Level Security policy patterns and failure modes -- policy bypass via service-role key in client code, USING-vs-WITH-CHECK confusion, missing INSERT policies that leave write paths unprotected. References GDPR Article 32 (Security of processing) and SOC 2 Trust Services Criteria CC6.1 (Logical and Physical Access Controls) for the least-privilege alignment. Triggers on Supabase table policy authoring (`CREATE POLICY`, `ALTER TABLE ... ENABLE ROW LEVEL SECURITY` references). OWASP ASI03 (Identity & Privilege Abuse) defense.
---

# Supabase Row-Level Security Policies

> Phase 2 Step 4 scaffold. Skill body is authored in session 4 batch 3.
> See `specs/phase-2/D-stack-specific-skills.md` REQ-D1 through REQ-D7 for
> the requirement bar this skill satisfies.
