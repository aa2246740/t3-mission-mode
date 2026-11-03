# Contribute a verified change

Use the setup and acceptance commands in [AGENTS.md](AGENTS.md). Start with a
reproduction in a temporary Mission, preserve the existing tests, and keep the
change tied to an observable user result.

Name functions and variables in `camelCase`, classes in `PascalCase`, constants in
`UPPER_SNAKE_CASE`, runtime modules in `kebab-case.mjs`, and behavior tests as
`*.test.mjs`. Format with `npm run format` and run `npm run check`. The pre-commit
hook repeats the fast checks; full runtime and security validation belong before
review and in CI.

Use the issue templates to record commands, expected results, environment, and
safe evidence. Choose one `priority: P0` through `priority: P3`, one `type: bug`,
`type: feature`, or `type: chore`, and the relevant `area:` labels. P0 means an
active integrity/security incident; P1 blocks a core lifecycle; P2 impairs a
supported workflow; P3 is maintenance or a small improvement.

Describe the final behavior, validation, and evidence limits in your PR. Bind
runtime results to the tested SHA. Distinguish mock/local adapters from actual
provider execution. Do not include raw prompts or credentials. The root owner
reviews changes to transactional storage, runtime transport, and release tooling.

Wait seven days before merging routine dependency updates. Keep direct versions
and the npm lockfile exact. A security patch can bypass that waiting period only
with its advisory, impact, and focused validation recorded in the change. The
Renovate configuration automates grouped, delayed proposals, but an actual bot PR
still depends on the repository's Renovate installation.
