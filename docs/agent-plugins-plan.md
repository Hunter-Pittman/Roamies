# Agent Plugins v1 implementation plan

Objective: implement https://agent-plugins.org/specification (published 1.0.0) as a usable Roamies plugin client. Obtain an Orca Codex **gpt-6-astra** plan review before implementation and a separate Astra code review after implementation and testing; resolve material findings before declaring completion.

## Scope and user experience

Support both portable component types: Agent Skills and MCP servers. Implement stdio and Streamable HTTP; include legacy SSE if the selected SDK supports it with the required redirect/endpoint protections. Unsupported transports must be explicitly reported and skipped rather than guessed. Directory loading is the conformance floor. No registry/marketplace, automatic downloads, arbitrary native UI hooks, or portable permission fields are defined by this spec.

Users manage plugins through conversation: inspect/install from a local directory, list/status, enable, disable, update/reload, uninstall, discover/use a skill, and discover/call MCP tools. Preserve Roamies' read-only supervisor overlay and existing interruption rules. Plugin errors are isolated and explained concisely. Do not add setup modals or task pickers.

The runtime must expose MCP capabilities through the shared AgentTool interface so both direct API brains and the existing Claude Code tool bridge work. Stable namespaced discovery/invocation tools can avoid rebuilding provider schemas whenever a server's tool list changes. Validate invocation input against the server's declared schema; return MCP errors and structured/text/image content through the correct host result format. Support paginated tool/resource/prompt discovery, resource reading, and prompt retrieval where servers advertise them; no server-provided instruction grants authority.

Plan-review integration findings verified against the installed runtime: an MCP result with `isError: true` must become an actual host tool error on both execution routes, with its diagnostic content retained. Do not merely return an `isError` property that the executor/Claude bridge discards. Test actual tool-call end error status, not just adapter return values.

## 1. Normative loader and conformance matrix

### Decisions after Astra review

- Install into owned versioned snapshots; installation leaves a plugin disabled. Enabling reviews an immutable descriptor and requires the actual confirmation callback, never a model-supplied approval boolean. Approval binds instance ID, package digest, resolved launcher identity, argv/env/cwd/endpoint descriptor and policy revision. PATH launcher identity is checked at launch; dependency bytes installed in PLUGIN_DATA, remote service code and future npx downloads are **not** attested by package hashes. The user grants the selected server broad tool authority with their user account; tool annotations cannot establish narrower per-action safety. An asynchronous approval must still match the exact current descriptor when accepted.
- Pin `@modelcontextprotocol/sdk` **1.32.2** (maintained v1 API, not v2 split-package examples), `yaml` **2.9.1**, and `ajv` **8.20.0**, using draft-2020-12 validation. Inspect installed versioned transport code before implementing it. Use declared initial transports only; no automatic fallback or call replay. SSE is unsupported unless its endpoint-origin behavior is covered by real tests.
- Normalize successful MCP content into host content blocks, with structured-only results serialized into visible text. Throw a redacted text-preserving host error for `isError`; rich error blocks are converted to diagnostics rather than incorrectly reported as successful tool content. Invocation arguments use an opaque JSON string envelope so nested nulls cannot be stripped by provider/Zod normalization, then undergo the actual server JSON Schema validation without remote-reference retrieval.
- Built-in agents use narrow parent-owned IPC. Bind selected plugin IDs and allowed operations to the actual child and package revisions; revoke at disconnect, disable/update, permission-off and shutdown. Never send plugin-management tools or secrets to workers.
- Orca supervisor MCP handoff is explicitly unavailable in the documented launch API. Selected skill material can be handed off with provenance; a requested MCP-dependent supervisor fails preflight before launch. No global configuration edits or invented transport flags. A separate authenticated standalone supervisor broker is deferred, not claimed as delivered.
- Runtime cleanup must own the process tree: Windows process-tree termination while its launcher identity is still owned, POSIX process groups for owned subprocesses. Bounded graceful close followed by termination; explicitly disclose detached descendants and already-committed remote effects cannot be undone. Windows script launchers require real argument-fidelity tests and must fail clearly if unsupported.
- YAML duplicate keys and unsafe aliases are rejected as parser/resource policy. The Skill spec's recommended line/token counts are not validation limits. Supporting files are not restricted to conventional subdirectory names. Record the Unicode name interpretation and reference evidence in the final conformance document.
- Client credentials, if configured, are origin/server-bound token bindings entered through the existing masked secret prompt, serialized under bounded hashed store keys, with explicit secret redaction. OAuth onboarding is not claimed; unsupported authentication is accurately reported per server.

Pin local copies of the official v1 plugin/MCP JSON schemas with provenance. Never fetch schemas during plugin loading. Use normative text where it differs from schema-only validation.

- Resolve the plugin root and every package path against real filesystem paths, including Windows junctions/reparse points and symlinked parents. Reject escapes at the narrow boundary required by §4, §6 and §7.
- Validate `plugin.json` first: recognized canonical `$schema`, required legal name, typed metadata, closed author object. Report/ignore unknown top-level fields and a non-object `extensions`; other violations reject the plugin. Unknown client extension namespaces are ignored without validating their values. Do not reject arbitrary metadata URLs, versions, licenses or email syntax merely for being unconventional.
- Discover only `skills/` immediate child directories containing exact regular `SKILL.md`, and root `mcp.json`. Missing components are valid. A malformed/escaping fixed component location disables that type, not its valid siblings.
- Parse skills with a maintained YAML parser; validate Agent Skills names, matching folder name, required description and optional fields according to https://agentskills.io/specification. Skip invalid skills individually. Advertise name/description, load instructions/resources only on demand, retain package containment for every supporting-file read. `allowed-tools` is not authorization to bypass Roamies policy.
- Validate MCP top-level document and matching schema version, then each closed server variant independently. One invalid server, connection failure or unsupported component must not disable independent valid components.
- Validate stdio executable as one bare token or `./` package path, preserve argument boundaries, reject shell command strings and unsupported executable path forms. Default cwd is plugin root. Explicit cwd is only `./`, `${PLUGIN_ROOT}`-rooted or `${PLUGIN_DATA}`-rooted and must remain in the corresponding real root.
- Single-pass expansion of exact `${PLUGIN_ROOT}` and `${PLUGIN_DATA}` only in args/env values/cwd. Other placeholder-like strings remain literal. No expansion in command, URLs, header names/values or env keys. Supply reserved variables last using platform env-name semantics; reject package declarations of reserved env names.
- HTTP endpoints must be absolute HTTP(S), no userinfo/fragment, HTTPS except exact localhost or literal loopback IP. Validate HTTP headers, reject case-insensitive duplicates, preserve client-generated header precedence, and never forward package headers across origins through redirects or SSE endpoint events without user consent.

Create a requirement-by-requirement conformance document mapping the applicable normative requirements to implementation and test evidence. Identify optional/unsupported features explicitly; do not claim full compatibility from a skills-only slice.

## 2. Installation, trust, storage and safety

Keep an owned registry and stable per-installed-instance data beneath `~/Roamies/Plugins` (respect `ROAMIES_DATA_DIR`). Use strict atomic writes and ownership/serialization like supervisors. Installed instance identity must not be just a manifest name; names can collide. Preserve PLUGIN_DATA across updates and restarts; uninstall keeps data by default unless its removal is explicitly requested.

Inspect a directory before any external code/network effect. Installation/enablement records a content fingerprint and concrete commands/endpoints. Prefer an owned, contained package snapshot to running directly from an editable source tree; snapshotting must preserve the spec's narrow component failure boundaries rather than rejecting the entire plugin for one broken skill/server. Any package-content or executable/endpoint change invalidates execution trust until the user accepts the concrete change. Do not auto-update to unreviewed code.

Use `safety.mjs` for package/data path reads/writes, executable/network effects and invocations. Add cases for each new rule. Plugin processes are trusted code with user-account access, not an OS sandbox; do not imply path containment confines a running subprocess. MCP annotations and skill content are not permission grants. Retain Allow File Edits & Commands as an execution gate. One install/enable trust decision should persist for unchanged content; ordinary approved calls should not trigger repeated generic confirmations. Reuse Roamie's existing confirmation/secret-entry mechanisms only when a new trust decision or credential is actually needed, after making the package review concrete.

Use a separate typed MCP endpoint check: the generic `web_fetch` rule deliberately rejects private/loopback destinations and must remain unchanged. An explicitly trusted, configured MCP origin can be loopback HTTP or a private HTTPS endpoint under the portable rules. This does not grant general network-fetch access or permission to follow arbitrary server-supplied URLs. Enforce origin/header checks in the actual transport fetch implementation.

Credentials belong to the client secret store, never package env/header literals, reports, ordinary model arguments or activity logs. The portable format defines no credential references or OAuth configuration. Authentication failures must be visible per-server failures; do not fake success or invent portable auth fields. Any client credential support must be separate and origin-bound.

## 3. MCP runtime and lifecycle

Use the official TypeScript MCP SDK if compatible with the current Node 22+ bundle and licensing. Add direct, pinned dependencies rather than relying on transitive packages. Verify version-matched primary docs. Use SDK framing/handshake, capability negotiation and transport cleanup.

Start/connect lazily after validation/trust/gates. Each server has independent status and bounded startup/call/cleanup; no silent resend of uncertain side effects. Sanitize ambient secrets and Orca identity variables from subprocess environments. Supply persistent plugin data and resolve commands with platform executable search. Verify Windows executable/`.cmd` handling without concatenating untrusted shell text.

Disable/uninstall/config-revocation closes connections and stops new invocations. Permission changes must be enforced at call time, including stale tools. Handle list-changed notifications, pagination, disconnects, timeouts, concurrent calls and shutdown. Avoid leaking child processes or startup failures into unrelated plugins. Distinguish connecting/ready/failed/auth-required/disabled where evidence supports the state. Provider tool schemas/results must pass the real gg-agent executor and Claude bridge tests.

## 4. Skills, agents and supervisors

Add enabled-skill metadata to Roamie's changing live context, never paste every skill body into the stable prompt. Provide a contained on-demand skill/resource reader; include source/root context so relative references are meaningful. Refresh availability after install/disable/update without leaving executable stale tools.

Built-in background agents require explicit capability selection/context, not a silent grant of every installed plugin or plugin-management tools. Determine the existing worker process boundary and implement an actual approved-capability handoff or broker as necessary; test it end-to-end.

Orca supervisors are independent processes. Do not claim they inherit app MCP connections. Inspect version-matched Orca launch/config capabilities before deciding the handoff. Deliver selected skill material and an explicit capability descriptor. If a supported launch-scoped MCP configuration or a scoped host broker can provide approved tools without changing global user configuration, implement and verify it. If the host cannot support a route, return an explicit unavailable capability before dispatch rather than promising access. Core Agent Plugins conformance itself does not standardize Orca-specific integration.

The installed Orca 1.4.258 `agent launch --help` exposes prompt/model/worktree/surface/focus/retry but no per-launch MCP configuration. Do not add an invented launch flag or edit global Codex/Orca settings as a workaround. Any supervisor tool bridge therefore needs its own explicit, scoped route and lifecycle tests.

## 5. Verification and review gates

Before implementation: Astra reviews this plan, the normative contracts and actual integration points. Revise the plan based on material findings.

Tests must exercise actual behavior, not just source text matching:

1. Table-driven manifest, skill and MCP validation: non-fatal versus fatal cases, missing/wrong-kind components, name collisions and malformed sibling isolation.
2. Real filesystem containment: symlinks, junctions/reparse points where available, parent links, dangling/missing descendants and runtime supporting-file/command/cwd reads. Cross-platform paths must not be tested only with POSIX strings on Windows.
3. Expansion/env cases: non-recursion, opaque args, reserved variables including Windows casing, per-instance persistent PLUGIN_DATA and updates/restarts.
4. Actual local fixture MCP subprocess and HTTP server (and SSE if supported): handshake, tools/resources/prompts, pagination/list changes, structured/text/image output, errors, cancellation/timeout, cleanup and failure isolation. No paid or external services needed.
5. Remote URL/header tests: loopback/IPv6, HTTPS requirement, invalid headers/duplicates, no interpolation, redirect/endpoint-origin protection and client-auth precedence. Do not fetch third-party credentials.
6. Trust lifecycle: no process/network before acceptance, changed content revokes trust, permission-off rejects calls, no auto resend, failed persistence never acknowledges success, disable/uninstall prevents stale invocations, crashes/restarts retain policy and data.
7. Real gg-agent executor and Claude tool bridge; built-in agent/supervisor handoff where claimed. Test hostile skill/server output as data rather than authorization.
8. Full sidecar suite, packaging with the bundled Node runtime/assets/dependencies, Windows debug build and app startup, shell tests, workflow script validation, and the conformance matrix. Preserve existing supervisor/notification behavior.

After implementation and tests: a separate Orca Astra review of the actual diff and evidence, focused on defects, compatibility, trust boundaries and missing coverage. Fix material findings, rerun affected checks, and request follow-up review where needed. Final completion requires current evidence for the objective, not just an implementation plan or passing narrow fixtures. No commit/push is required by this goal unless the user requests it.
