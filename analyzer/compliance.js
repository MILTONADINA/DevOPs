// analyzer/compliance.js
//
// specs/ops/analyzer-detection.md REQ-6: the compliance scope `devops analyze`
// reads from a README. Terms match as whole words, and the words that also
// have ordinary meanings ("child", "minor", "patient") count only next to a
// data term, so "a minor release of a graphics library" adds nothing.

// A data or account term near a group term: same sentence, within 60 characters.
const NEAR = '[^.!?\\n]{0,60}';
const DATA = '(?:data|information|records?|privacy|personal|accounts?|profiles?)';
const near = group => new RegExp(`\\b${group}\\b${NEAR}\\b${DATA}\\b|\\b${DATA}\\b${NEAR}\\b${group}\\b`);

const RULES = [
  {
    cls: "children's data",
    scope: 'COPPA',
    // "children" alone is a tree term in UI libraries, so only these phrases count.
    patterns: [/\bcoppa\b/, /\bunder[ -]?13\b/, /\bk-12\b/, new RegExp(`\\bchildren's ${DATA}\\b`), new RegExp(`\\b${DATA} (?:about|of|from) children\\b`), near('(?:kids?|minors|students?|pupils?)')],
  },
  {
    cls: 'PHI',
    scope: 'HIPAA',
    patterns: [/\bhipaa\b/, /\bphi\b/, /\bprotected health information\b/, /\bhealth records?\b/, near('(?:patients?|medical)')],
  },
];

/** Each compliance class the README text implies, with the term that matched. */
export function readmeCompliance(readme) {
  const text = readme.toLowerCase();
  const hits = [];
  for (const rule of RULES)
    for (const pattern of rule.patterns) {
      const match = pattern.exec(text);
      if (match) { hits.push({ cls: rule.cls, scope: rule.scope, term: match[0].replace(/\s+/g, ' ') }); break; }
    }
  return hits;
}
