---
name: analyze
description: Re-run the project analyzer. Updates .workflow/profile.yml with current stack detection. Use after major dependency changes, framework migrations, or any time the project shape shifts.
---

# /analyze

```bash
npm run analyze
```

Run it from the DevOPs repo root. In another project, run the analyzer from that
project's root (it scans the current directory), with the installed package
(`npm install -g @miltonadina/devops`):

```bash
devops analyze
```

Produces `.workflow/profile.yml`. Recommendations are summarized in the output;
to install recommended components, run `devops init` from the project root
(`devops init --dry-run` first shows what it would do).
