# DESIGN_PARTNER.md — Running the Design Partner Program

## Purpose

A design partner is not a beta user. They are a co-builder. They give you access to real data and real feedback. In return, they get free software, your full attention, and a product shaped around their pain.

You need exactly one design partner before Phase 2. Not five — one. Do it right with one before scaling.

---

## Target Profile

**The Fractional CTO Agency** — a small firm (2–8 people) that manages multiple startup codebases simultaneously. They use Claude Code heavily and are drowning in context bleed and API costs.

Why they're the ideal first customer:

- They have multiple repos → tests cross-project memory
- They spend $1,000–$3,000/month on API credits → savings are meaningful
- They are technical → they will give precise feedback, not vague complaints
- They work across many projects → they feel "context bleed" acutely
- They are cost-conscious → the token arbitrage model resonates immediately

---

## Finding Them

**Where they are:**
- Discord servers: Cursor, Claude Code, Buildspace, Indie Hackers
- Twitter/X: Search "Claude Code" + "tokens" or "context window" + complaints
- LinkedIn: "Fractional CTO" in title
- Reddit: r/ClaudeAI, r/LocalLLaMA, r/MachineLearning — find people complaining about API costs
- Local tech meetups: OKC tech community, startup events

**The outreach message (DM, not email):**

> "Hey — I saw your post about Claude Code eating through your API budget. I'm building a token compression proxy that sits in front of the Anthropic API and cuts context waste by ~85%. I want to give one agency free access in exchange for real usage data and honest feedback. Would you be open to a 20-minute call to see if it's relevant for you?"

Key: reference something specific they said. Generic outreach gets ignored.

---

## The First Call (20 minutes)

**Goal:** Determine if they are the right design partner. Not pitching — qualifying.

Questions to ask:

1. How many Claude Code sessions per day across your team?
2. What's your current monthly Anthropic API spend?
3. Have you hit any cases where the AI "forgot" a decision you made earlier in the week?
4. Do you work across multiple codebases? Do you ever notice context from one project bleeding into another?
5. Would you be willing to share anonymized API logs so we can measure your actual waste?

**Disqualifiers:**
- Less than $500/month API spend (savings won't be meaningful)
- Not using Claude Code or similar agentic tools (different use case)
- Unwilling to share logs (you need data)

**Qualifiers:**
- Specific pain story about context or costs (they feel the problem)
- Multiple repos or projects (tests more of the system)
- Technical enough to understand token counts

---

## The Design Partner Agreement

Keep it simple. One page. Key terms:

1. **Duration:** 90 days
2. **Cost:** Free for the design partner
3. **What CQ provides:** Full access to Phase 1 and Phase 2 builds, direct line to the founder
4. **What the design partner provides:**
   - Allows the proxy to run on their Claude Code sessions
   - Shares anonymized session logs (no code content — just token counts and metadata)
   - One 30-minute feedback call per month
   - Honest feedback on quality and utility
5. **Data handling:** Token counts and metadata only. Source code never leaves their environment.
6. **Exit:** Either party can cancel with 7 days notice.

Do not use lawyers for this. A signed Google Doc is sufficient for Phase 1.

---

## Running the Partnership

### Week 1 — Onboarding
- Install the Phase 1 proxy on their machine
- Verify it's routing correctly (`ANTHROPIC_BASE_URL=http://localhost:4080`)
- Confirm the dashboard is showing real numbers
- Set a baseline: their actual API spend before CQ

### Weeks 2–4 — Measurement Phase
- Check in twice a week (Slack DM, not calls)
- Ask: "Anything feel different? Slower? Broken?"
- Watch the dashboard daily. Flag anomalies.
- Document their waste profile: which categories dominate?

### Month 2 — Pruning Phase (Phase 2 ready)
- Enable KadaneDial pruning
- Watch the dashboard for: token delta, savings estimate
- Critical question to ask them every week: **"Has the AI quality felt any different?"**
- If they say yes (worse): treat it as a P0 bug. Investigate immediately.
- Track the Context-to-Commit Ratio: tokens per bug fix, before and after

### Month 3 — Metric Capture
- You need three numbers for your pitch deck:
  1. Average pruning effectiveness % (e.g., 87%)
  2. Monthly API cost before vs. after (e.g., $2,100 → $315)
  3. Any qualitative improvement in AI quality (developer quotes)
- Ask for a testimonial. Ask if they'll be a reference.
- Ask: "What would you pay for this?" (Don't anchor. Let them answer first.)

---

## The Data You're Collecting

From the design partner's sessions, you need to build:

| Dataset | Used for |
|---|---|
| Raw token counts per session | Proving arbitrage model math |
| Waste category breakdown | Validating Phase 0 taxonomy |
| Pruning effectiveness % | Proving KadaneDial works |
| AI quality ratings (weekly survey) | Proving no quality degradation |
| Context-to-Commit Ratio | Developer-facing sales metric |

Store all of this in `data/design-partner/` (gitignored). Anonymize before using in pitch decks.

---

## What Success Looks Like

At the end of 90 days, you should be able to say:

> "[Agency name] ran 847 Claude Code sessions through CQ over 90 days. Their average pruning effectiveness was 87%. Their API spend dropped from $2,100/month to $273/month. They reported no degradation in code quality. Their lead developer said: '[quote]'. They have agreed to pay $X/month when we launch billing."

That statement is your seed round pitch. Everything else is secondary.

---

## Red Lines

- If the design partner reports quality degradation and you can't fix it in 48 hours, turn off pruning and go back to measurement-only mode. Never let them suffer a broken product.
- If they ask you to prune code that's currently being edited (active files), exclude those files from pruning. The active context is always sacred.
- Do not overpromise features. Tell them what phase you're in and what's coming. Founders who over-promise lose trust.
