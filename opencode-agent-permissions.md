# OpenCode agent permission actions (V2)

Reference for the `permissions` section of agent definitions — the frontmatter of
`.opencode/agents/<name>.md` files, or an `agents.<id>.permissions` entry in
`opencode.json(c)`. Source: <https://opencode.ai/v2/docs/permissions/>.

## Rule shape

Each permission is an ordered rule with three string fields:

| Field | Meaning |
| --- | --- |
| `action` | Tool permission action (see table below) |
| `resource` | Value being used: path, command, URL, query, skill ID, agent ID… |
| `effect` | `allow` (run without prompting), `deny` (block), or `ask` (wait for a decision) |

```yaml
permissions:
  - action: edit
    resource: "*"
    effect: deny
```

- Rules combine in order and the **last matching rule wins**, so put broad rules
  first and exceptions after them.
- If no rule matches, OpenCode uses `ask` — but every agent starts from a base
  policy that allows everything (with `ask` exceptions for `external_directory`
  and `*.env` reads). Agent rules are appended after that base policy.

## Built-in actions

| Action | What its `resource` matches |
| --- | --- |
| `read` | File path (location-relative, or canonical absolute for external paths) |
| `edit` | Target path — covers the `edit`, `write`, and `patch` tools |
| `glob` | The requested glob pattern |
| `grep` | The requested regular expression (not the search path) |
| `shell` | The scanner-produced command string; compound commands produce several checks |
| `subagent` | Target agent ID |
| `skill` | Skill ID |
| `question` | `*` |
| `webfetch` | Requested URL |
| `websearch` | Search query |
| `external_directory` | Canonical external directory boundary (normally ending in `/*`) |
| `<server>_<tool>` | MCP tools — e.g. `pg-aiguide_view_skill`, `cloudflare-docs_search_cloudflare_documentation` |
| `execute` | `*` — controls Code Mode availability (nested tools still enforce their own rules) |

## Matching rules

- Actions and resources support simple whole-value wildcards:
  - `*` — zero or more characters, including `/`
  - `?` — exactly one character
  - anything else is matched literally
- The `action` field itself accepts wildcards — used for catch-all rules
  (`action: "*"`) and MCP server prefixes (`pg-aiguide_*`).
- A shell pattern ending in ` *` also matches the command without arguments:
  `"git status *"` matches both `git status` and `git status --short`.
- For `read`, `edit`, and `external_directory` resources, a leading `~`, `~/`,
  `$HOME`, or `$HOME/` is expanded when configuration loads. Shell resources
  stay raw command text and are not expanded.
- Reading or editing outside the workspace needs `external_directory` approval
  *before* the `read`/`edit` rule is checked.
- Operations may check several resources (e.g. a patch touching multiple files):
  any `deny` denies the operation; otherwise any `ask` asks; otherwise allowed.

## Notes

- Action names are plain strings, so **plugins may define additional actions** —
  the table above is what V2 core currently uses.
- `doom_loop` and `lsp` are **not** V2 core permission actions (V1 leftovers).
- V1 names are invalid in V2: use `permissions` (not `permission`), `shell`
  (not `bash`), and `subagent` (not `task`).
