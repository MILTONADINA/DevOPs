-- Migration: 20260529170000_composite_org_fks.sql
-- PB-32: enforce ORG MEMBERSHIP on cross-row foreign keys (Session-17 adversarial
-- review finding). Previously developer_id / assigned_to / supersedes_id /
-- acknowledged_by referenced their parent by id ALONE, so a row in org B could
-- reference a developer/decision in org A — a cross-tenant integrity gap. These
-- columns are currently always NULL (the extractor strips them; server-side
-- resolution = the future audit engine), so applying this NOW — while the tables are
-- empty — is the safe time (a later migration on populated data would be riskier).
--
-- Fix: composite FKs `(org_id, <col>) REFERENCES <target>(org_id, id)`. With the
-- default MATCH SIMPLE semantics, a NULL `<col>` leaves the FK unchecked (NULL
-- attribution still allowed), but a NON-NULL value MUST point at a row in the SAME
-- org. Requires UNIQUE(org_id, id) on the referenced tables as the FK target.
-- ON DELETE stays NO ACTION (consistent with the soft-delete design — PB-33).

-- ── Composite-FK targets ──────────────────────────────────────────────────────
ALTER TABLE developers     ADD CONSTRAINT developers_org_id_id_key     UNIQUE (org_id, id);
ALTER TABLE tech_decisions ADD CONSTRAINT tech_decisions_org_id_id_key UNIQUE (org_id, id);

-- ── developer_id → developers(org_id, id) ─────────────────────────────────────
ALTER TABLE sessions          DROP CONSTRAINT sessions_developer_id_fkey;
ALTER TABLE sessions          ADD  CONSTRAINT sessions_developer_id_fkey          FOREIGN KEY (org_id, developer_id) REFERENCES developers(org_id, id);
ALTER TABLE function_changes  DROP CONSTRAINT function_changes_developer_id_fkey;
ALTER TABLE function_changes  ADD  CONSTRAINT function_changes_developer_id_fkey  FOREIGN KEY (org_id, developer_id) REFERENCES developers(org_id, id);
ALTER TABLE tech_decisions    DROP CONSTRAINT tech_decisions_developer_id_fkey;
ALTER TABLE tech_decisions    ADD  CONSTRAINT tech_decisions_developer_id_fkey    FOREIGN KEY (org_id, developer_id) REFERENCES developers(org_id, id);
ALTER TABLE policy_updates    DROP CONSTRAINT policy_updates_developer_id_fkey;
ALTER TABLE policy_updates    ADD  CONSTRAINT policy_updates_developer_id_fkey    FOREIGN KEY (org_id, developer_id) REFERENCES developers(org_id, id);
ALTER TABLE todos             DROP CONSTRAINT todos_developer_id_fkey;
ALTER TABLE todos             ADD  CONSTRAINT todos_developer_id_fkey             FOREIGN KEY (org_id, developer_id) REFERENCES developers(org_id, id);
ALTER TABLE variable_changes  DROP CONSTRAINT variable_changes_developer_id_fkey;
ALTER TABLE variable_changes  ADD  CONSTRAINT variable_changes_developer_id_fkey  FOREIGN KEY (org_id, developer_id) REFERENCES developers(org_id, id);

-- ── todos.assigned_to → developers(org_id, id) ────────────────────────────────
ALTER TABLE todos DROP CONSTRAINT todos_assigned_to_fkey;
ALTER TABLE todos ADD  CONSTRAINT todos_assigned_to_fkey FOREIGN KEY (org_id, assigned_to) REFERENCES developers(org_id, id);

-- ── tech_decisions.supersedes_id → tech_decisions(org_id, id) (same-org supersession) ──
ALTER TABLE tech_decisions DROP CONSTRAINT tech_decisions_supersedes_id_fkey;
ALTER TABLE tech_decisions ADD  CONSTRAINT tech_decisions_supersedes_id_fkey FOREIGN KEY (org_id, supersedes_id) REFERENCES tech_decisions(org_id, id);

-- ── audit_conflicts.acknowledged_by → developers(org_id, id) ──────────────────
ALTER TABLE audit_conflicts DROP CONSTRAINT audit_conflicts_acknowledged_by_fkey;
ALTER TABLE audit_conflicts ADD  CONSTRAINT audit_conflicts_acknowledged_by_fkey FOREIGN KEY (org_id, acknowledged_by) REFERENCES developers(org_id, id);
