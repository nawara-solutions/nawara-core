# Architecture documents

Whole-system documents for Nawara Core. They are **living** (updated as the architecture evolves); the decisions behind them are
recorded as ADRs in [`../adr/`](../adr). `docs/README.md` is shared with other repositories through a symlink, so this folder is
indexed here instead.

| Document | Answers |
|---|---|
| [`core-architecture.md`](./core-architecture.md) | Service inventory, ownership, dependencies, events, identity and organization-context flow, service authentication |
| [`financial-architecture.md`](./financial-architecture.md) | Billing, payment and accounting boundaries, data model, authority, open business/legal decisions |
| [`production-readiness.md`](./production-readiness.md) | CI/CD, deployment safety, database roles, backups, migrations |
| [`service-foundations.md`](./service-foundations.md) | What is implemented, designed and deferred; verification evidence; decisions awaiting approval |
