# Lifecycle Phases

Each project moves through phases. The current phase is recorded in
`.workflow/state/lifecycle.txt`.

| Phase | Purpose | Exit when |
|-------|---------|-----------|
| discovery | Understand problem, users, constraints | Spec exists for at least one feature |
| design | Architect the system | Architecture doc + threat model + ADRs filed |
| build | Implement features | All MVP specs implemented and verified |
| harden | Tighten security, perf, observability | Tier 3 security scans pass; SLOs measurable |
| launch | Deploy to production with confidence | Live; SLOs healthy for 7 days |
| operate | Run reliably; respond to incidents | Always ongoing |
| evolve | Iterate based on usage | Always ongoing |

Each phase has its own `PHASE.md` listing skill bundle and acceptance gates.
