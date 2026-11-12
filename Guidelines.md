# Project Guidelines

These guidelines apply to every functionality and code change in this project.

## Required rule-compliance check

Before starting work, read and apply all project rule documents:
[laws.md](./laws.md), [Roles.md](./Roles.md), [Signals.md](./Signals.md), and
this file. These documents apply together. Vercel's built-in deployment flow
satisfies the automated-pipeline requirement in `laws.md`; do not add a
separate YAML-based CI/CD workflow.

Before calling a change ready, complete this checklist and show its results in
the terminal:

- **Scope and design:** the Product Manager's goal and acceptance criteria are
  clear, and the Architect confirms the change respects the Node.js layers.
- **Tests:** for behavior changes, follow the Red-Green-Refactor sequence in
  `laws.md`; run relevant tests and build checks, and report their actual
  results. Do not claim a check passed if it was not run.
- **Security:** the Sentinel checks authorization/ownership, boundary input
  validation, and secret handling where relevant. Report risks and blockers.
- **Deployment:** verify the change uses Vercel's deployment flow and adds no
  separate YAML CI/CD workflow.
- **Roles:** print a labeled verdict from every role listed below. No role may
  be silently omitted.
- **Outcome:** record unresolved objections or escalations with their reasons.
  Mark the change **BLOCKED** if a required verdict or check is missing, a
  blocking finding is open, or a required test/build check fails. Only the
  Release Coordinator may state the final **SHIP**, **SHIP WITH CONDITIONS**,
  or **HOLD** decision.

Use the signal meanings in `Signals.md`: an objection must include a reason;
use an escalation when disagreement needs a higher-level decision. A signal
does not replace a role's verdict or waive a required check. If a rule cannot
be followed or verified, state the limitation and mark the affected check
**BLOCKED** instead of silently bypassing it.

## Role verdicts for functionality work

For each functionality, consult all 11 roles defined in [Roles.md](./Roles.md):

1. Product Manager
2. UX Advocate
3. Downstream Advocate
4. Architect
5. Test Architect
6. Implementor
7. Reviewer
8. Critic
9. Sentinel
10. Sage
11. Release Coordinator

Each role must provide a concise, clearly labeled verdict. A role may report
"No concerns" when appropriate, but must not be silently skipped. Keep each
role within its responsibilities and do not let the Implementor approve their
own work. Resolve blocking findings before recommending release; escalate
unresolved disagreements to the Sage and leave the final ship decision to the
Release Coordinator.

Show the complete set of role verdicts in the terminal for every functionality.
The terminal output must identify each role and state its verdict, including
any findings, blockers, conditions, or reason for a hold. Do not report a
functionality as approved or ready to ship while required verdicts are missing
or blocking findings remain unresolved.

## Deployment and CI/CD

- This application is deployed on Vercel. Use Vercel's built-in CI/CD and
  deployment services.
- Do not add a YAML file or configure a separate repository-based YAML
  workflow for CI/CD.
- Keep project build and test commands usable by Vercel's deployment pipeline.
- Do not deploy manually from a developer's local machine; use the configured
  Vercel deployment flow.

## Node.js layered architecture

Use Node.js and organize application code into layers with clear
responsibilities. Adapt folder names to the existing project structure rather
than introducing duplicate conventions.

- **Presentation:** HTTP routes, controllers, request parsing, response
  formatting, and input validation at the application boundary.
- **Application:** use cases and orchestration of application workflows.
- **Domain:** business rules, entities, and domain-level policies; keep this
  layer independent of web frameworks, Vercel, and persistence technology.
- **Infrastructure:** database access, external services, framework/runtime
  adapters, and Vercel-specific integration.

Dependencies should point inward: presentation and infrastructure may depend
on application/domain contracts, but domain logic must not depend on outer
layers or platform-specific details. Keep business logic out of route handlers,
and keep database and external-service details behind infrastructure
implementations. Use dependency injection or explicit interfaces where needed
to preserve these boundaries without adding unnecessary abstraction.
