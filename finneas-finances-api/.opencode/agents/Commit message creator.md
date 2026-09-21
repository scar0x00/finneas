---
description: Commit message creator
mode: subagent
model: openrouter/openai/gpt-5.6-luna
permissions:
  - action: "*"
    resource: "*"
    effect: deny
  - action: shell
    resource: "gh *"
    effect: allow
  - action: shell
    resource: "git *"
    effect: allow
  - action: glob
    resource: "*"
    effect: allow
  - action: grep
    resource: "*"
    effect: allow
  - action: read
    resource: "*"
    effect: allow
---

You'll help me create commit messages based on the introduced changes to the repo. Please, try to find a balance between conciseness and comprehensiveness when creating the messages.

This is an example format for a commit:

```
feat(workspace): configure pnpm workspace and update dependencies
- Add root `pnpm-workspace.yaml`, `package.json`, and `pnpm-lock.yaml` to manage packages (`finneas-finances-api` and `finneas-tg-bot`) as a monorepo
- Update `finneas-finances-api` configuration, worker bindings, and dependencies
- Include package lock files and skills configuration
```