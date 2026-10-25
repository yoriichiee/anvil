# Security policy

## Reporting a vulnerability

Please **do not open a public issue** for security problems. Report them privately through GitHub:
**Security > Advisories > Report a vulnerability** on this repository's GitHub page (a private security
advisory). Include what you found, how to reproduce it, and the impact you expect.

We aim to acknowledge reports within a few days and to publish a fix and an advisory once it is ready. Please give us
reasonable time to fix the issue before disclosing it.

## Scope

Anvil is a local tool: it binds to 127.0.0.1, proxies one app under test, runs commands from the project's
`anvil.config.json`, and posts PR comments with the GitHub CLI after the tester confirms. Relevant reports include,
for example: ways for a web page to reach Anvil's API from another origin, path traversal in served files, the proxy
leaking or logging secrets, the report leaking `copilot.security` notes, or a plan file causing commands to run that
the config did not define.

`anvil.config.json` is trusted input (it comes from the repository you chose to test, like a `package.json` script);
treat configs from untrusted repositories with the same care as any build script.

## Supported versions

Security fixes go into the latest release.
