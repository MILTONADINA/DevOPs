---
name: analyze
description: Re-run the project analyzer. Updates .workflow/profile.yml with current stack detection. Use after major dependency changes, framework migrations, or any time the project shape shifts.
---

# /analyze

```bash
npm run analyze
```

Run it from the DevOPs repo root. In another project, run the analyzer from that
project's root (it scans the current directory), with `DEVOPS_ROOT` set to the
DevOPs checkout when it is not at `~/DevOPs`:

```bash
bash "${DEVOPS_ROOT:-$HOME/DevOPs}/scripts/analyze.sh"
```

Produces `.workflow/profile.yml`. Recommendations are summarized in the output;
to install recommended components, run
`bash "${DEVOPS_ROOT:-$HOME/DevOPs}/scripts/init-project.sh"` from the project root
(inside the DevOPs repo itself, `DEVOPS_ROOT="$PWD" ./scripts/init-project.sh`).
