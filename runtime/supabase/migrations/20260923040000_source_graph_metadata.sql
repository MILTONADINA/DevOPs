-- Source graph entities share Tier-3 tables with promoted memory facts.
-- Existing rows keep nullable metadata; File nodes and source edges get new kinds.
ALTER TABLE knowledge_entities DROP CONSTRAINT knowledge_entities_kind_check;
ALTER TABLE knowledge_entities ADD CONSTRAINT knowledge_entities_kind_check
  CHECK (kind IN ('Function', 'Commit', 'Decision', 'Developer', 'Policy', 'Project', 'File'));
ALTER TABLE knowledge_entities ADD COLUMN file_path TEXT;
ALTER TABLE knowledge_entities ADD COLUMN summary TEXT;

ALTER TABLE knowledge_edges DROP CONSTRAINT knowledge_edges_edge_type_check;
ALTER TABLE knowledge_edges ADD CONSTRAINT knowledge_edges_edge_type_check
  CHECK (edge_type IN ('SUPERSEDES', 'DEPRECATED_BY', 'REFERENCED_IN',
                      'AUTHORED_BY', 'APPLIES_TO', 'DECLARES', 'DEPENDS_ON'));
