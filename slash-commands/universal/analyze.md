---
name: analyze
description: Re-run the project analyzer. Updates .workflow/profile.yml with current stack detection. Use after major dependency changes, framework migrations, or any time the project shape shifts.
---

# /analyze

```bash
node ~/DevOPs/analyzer/scan.js
```

Produces `.workflow/profile.yml`. Recommendations are summarized in the output;
to install recommended components, run `./scripts/init-project.sh`.
