-- Keep every graph reference inside its owning organization. Adding each FK
-- validates existing rows; a mismatched historical row aborts this migration.
ALTER TABLE sessions ADD CONSTRAINT sessions_org_id_id_key UNIQUE (org_id, id);
ALTER TABLE knowledge_entities ADD CONSTRAINT knowledge_entities_org_id_id_key UNIQUE (org_id, id);

ALTER TABLE knowledge_entities DROP CONSTRAINT knowledge_entities_session_id_fkey;
ALTER TABLE knowledge_entities ADD CONSTRAINT knowledge_entities_session_id_fkey
  FOREIGN KEY (org_id, session_id) REFERENCES sessions(org_id, id);

ALTER TABLE knowledge_edges DROP CONSTRAINT knowledge_edges_session_id_fkey;
ALTER TABLE knowledge_edges ADD CONSTRAINT knowledge_edges_session_id_fkey
  FOREIGN KEY (org_id, session_id) REFERENCES sessions(org_id, id);

ALTER TABLE knowledge_edges DROP CONSTRAINT knowledge_edges_from_entity_fkey;
ALTER TABLE knowledge_edges ADD CONSTRAINT knowledge_edges_from_entity_fkey
  FOREIGN KEY (org_id, from_entity) REFERENCES knowledge_entities(org_id, id) ON DELETE CASCADE;

ALTER TABLE knowledge_edges DROP CONSTRAINT knowledge_edges_to_entity_fkey;
ALTER TABLE knowledge_edges ADD CONSTRAINT knowledge_edges_to_entity_fkey
  FOREIGN KEY (org_id, to_entity) REFERENCES knowledge_entities(org_id, id) ON DELETE CASCADE;
