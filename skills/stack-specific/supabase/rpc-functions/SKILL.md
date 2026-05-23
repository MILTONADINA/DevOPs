---
name: supabase-rpc-functions
description: Supabase RPC function security patterns -- SECURITY DEFINER with `SET search_path` discipline, `REVOKE EXECUTE FROM public` for least-privilege exposure, JSON-arg shape drift between client and server contracts. Triggers on Supabase RPC function authoring (`CREATE OR REPLACE FUNCTION`, `rpc(` client calls). OWASP ASI02 (Tool Misuse) defense -- RPCs that bypass RLS are a privileged-backdoor path.
---

# Supabase RPC Functions

> Phase 2 Step 4 scaffold. Skill body is authored in session 4 batch 3.
> See `specs/phase-2/D-stack-specific-skills.md` REQ-D1 through REQ-D7 for
> the requirement bar this skill satisfies.
