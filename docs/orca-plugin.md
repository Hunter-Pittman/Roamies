# Bundled Orca plugin

Orca is provided by `showcase/tauri/sidecar/bundled-plugins/orca`, an Agent Plugins 1.0.0 package with `plugin.json`, `mcp.json`, an Orca skill, the supervisor skill, and a stdio MCP server. The build bundles its server independently into the shipped package. The app no longer imports the Orca client or registers Orca status/dispatch tools directly, and its stable prompt no longer embeds Orca workflow instructions.

On startup the plugin manager installs an owned snapshot of app-shipped code and enables it to replace the former built-in integration. It appears as `roamies.orca` in `plugins`. Bundled code is trusted with the app; it does not trigger a new setup approval. Third-party copies, even with the same name or extension metadata, receive ordinary disabled installation and approval, and cannot acquire host privileges. The client selects its shipped Node executable, so a separate Node installation is unnecessary.

Disable/enable it using `manage_plugin` in conversation. A disabled preference survives restart and app updates. Uninstalling a bundled plugin disables its installed instance; app resources and saved data are retained. Bundled code updates with the app; arbitrary replacement directories cannot inherit a bundled instance's privileges.

The portable MCP tools provide live Orca activity, workspaces, task history, task watches, supervisor dispatch/messaging and observation controls. Read-only status and observation remain usable when Allow File Edits & Commands is off. Launching or messaging still requires that setting. No raw shell fallback, mailbox consumption or automatic uncertain-delivery replay was added.

The app retains the supervisor state owner, report ingestion, notification preferences/delivery and read-only overlay. Its `supervisors` and `interruption_rules` tools remain available even when the Orca plugin is disabled. Existing state stays in `~/Roamies/Supervisors` (or its configured data directory). Independent Orca agents continue running when the plugin is disabled; saved reports still display and coordinator report files can still be ingested. Passive watches show an unavailable connection until the plugin is enabled again.

## Roamies host extension

`extensions["io.roamies.host"]` documents the package's host dependency; it does not grant privileges. App-owned bindings in `bundled-plugins.mjs` authorize a specific managed bundled instance, server and service/operation list. Every request rechecks enablement, package/launcher integrity, revocation and dispatch permissions through `safety.mjs`.

The MCP connection uses the namespaced `io.roamies/host` request to reach the supervisor service, and `io.roamies/orca` for host-initiated typed Orca operations. Bidirectional requests let the existing saved-state manager use the same plugin connection without a second Orca implementation. Third-party servers cannot use these bindings. No service grants filesystem, credential or arbitrary module access. This bridge is a Roamies-specific MCP extension; in other clients, supervisor operations report that the host service is unavailable, while ordinary Orca status/history can work with that client's Node/Orca setup.

This does not add MCP configuration to independent Orca supervisor launches. Requests requiring such access still fail preflight as documented in the plugin framework's conformance record.

## Verification

`test/orcaplugin.test.mjs` builds the actual plugin and runs it through the actual MCP runtime. Disposable executable/CLI fixtures exercise live status with actions off, task history, nested supervisor host callbacks, dispatch/deduplication, messaging, saved completion briefs, restart and disabled preferences, revocation, ambient identity stripping and denial of host access to a same-name third-party copy. No real project work is launched. Existing supervisor tests attach the plugin-owned definitions through `test/supervisorfixture.mjs`; the domain manager itself no longer supplies model tools. The relocated packaged-runtime smoke also verifies the bundled plugin is installed and enabled using the shipped Node.

Verification completed on Windows: all 72 sidecar test files, 12 shell tests, debug build, workflow inline scripts and the relocated packaged-runtime smoke passed. Targeted follow-up suites covered provider routes and durable uncertain-launch IDs after hardening. A read-only query through the packaged MCP server against the running Orca instance succeeded with complete reported coverage. Its runtime discovery requires APPDATA on Windows; the bundled client forwards OS configuration-directory hints while stripping coordinator/session identities from CLI calls.
