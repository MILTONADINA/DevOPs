---
name: unsigned-mismatched-sig-fixture
description: Test fixture (F.09) — SKILL.md whose accompanying .sig signs different content. NFR-F3 hash check catches this even with --allow-unsigned.
---

# Mismatched signature

This fixture's .sig was copied from a DIFFERENT skill. The hash check
(defense-in-depth per NFR-F3) refuses this regardless of --allow-unsigned.
