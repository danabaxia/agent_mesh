# orchestrator

Mesh ops / observability. Watches the society's GitHub-Actions runs and surfaces
them as live mesh activity; owns the scheduled `gh-activity-poll` (and, later, the
mesh-level self-healing heartbeat). Read-only — never writes code or merges.
