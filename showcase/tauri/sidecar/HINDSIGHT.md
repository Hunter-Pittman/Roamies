# Hindsight retrieval trial

This first stage compares Hindsight against Roamies' existing lexical retrieval using the **same approved facts**.
It does not retain conversations, screenshots, tool results, commitments, or assistant claims. It preserves the
150-fact cap, local JSON storage, reminders, and folder sync. Enable it with **Memory → Hindsight memory**.
It starts off by default. The choice is saved and takes effect immediately, without restarting the app.

## Quick setup

Install Node.js 22+ and Docker with Compose, start Docker, and sign in to ChatGPT in Roamies. From the repo root:

```sh
node setup-hindsight.mjs
```

The script checks prerequisites, installs missing sidecar dependencies using `npm ci`, starts the pinned local
Hindsight container and the Roamies provider bridge, and waits for the server to become healthy. It reuses a
running service. Keep the setup terminal open while using Hindsight; then turn on **Hindsight memory** on the
Memory page. The panel shows connection status and **Check again** if you start the service after the app.

`node setup-hindsight.mjs --check` checks prerequisites and service health without installing or starting anything.
`--help` shows usage. Initial setup downloads the Docker image and local embedding/reranking models.
The automatic bridge currently supports an existing Roamies ChatGPT sign-in. Other inference providers can
be configured manually as below. On Linux, the bridge setup needs Docker's `host.docker.internal` host gateway
to reach the loopback provider bridge; the automated path has been verified with Docker Desktop on Windows.

## Start a server

Use a separately configured local Hindsight server or the included Docker Compose file. The server needs its own
supported inference configuration. For an existing Roamies ChatGPT sign-in, use the bridge below.
Storage is local, but a cloud inference provider still receives retained facts and may receive recall queries.
The pilot rejects secret-like queries and filters facts again before indexing; these checks are not a guarantee
that arbitrary personal information is removed. Only enable this for a provider you intend to receive your facts.

From this directory in PowerShell, after setting your model provider, model name, and credentials in the shell:

```powershell
$env:HINDSIGHT_API_LLM_PROVIDER = 'your-supported-provider'
$env:HINDSIGHT_API_LLM_MODEL = 'your-model-name'
# Set HINDSIGHT_API_LLM_API_KEY in the process environment when required; do not save it in the repo.
docker compose -f hindsight.compose.yml up -d
Invoke-RestMethod http://127.0.0.1:8888/health
$env:ROAMIES_HINDSIGHT_URL = 'http://127.0.0.1:8888'
```

`HINDSIGHT_IMAGE` can override the pinned image digest; record it with benchmark results. Configure local
inference using the supported Hindsight provider settings;
inside Docker, a host model server is normally reached through `host.docker.internal`, not container loopback.
See [provider configuration](https://hindsight.vectorize.io/developer/models) and
[installation](https://hindsight.vectorize.io/developer/installation).

The initial comparison used a local-only synthetic experiment, excluded from the repository. The recorded
results below are a small smoke comparison, not a quality benchmark or a measurement of end-to-end replies.

### First live result (2026-11-15)

Tested the pinned Docker image on this Windows machine, using the existing Roamies ChatGPT sign-in and
`gpt-6-luna` through the provider bridge. The four older target facts were mixed with sixty newer distractors.
All four queries paraphrased their target without matching its main keywords. Within the same forty-fact
selection, the baseline retrieved 0/4 targets and the Hindsight selection retrieved 4/4.

| Query topic | Baseline hit | Hindsight hit | Recall latency |
| --- | --- | --- | --- |
| Video editing application | No | Yes | 350 ms |
| Dietary restriction | No | Yes | 307 ms |
| Android UI technology | No | Yes | 313 ms |
| Notes application | No | Yes | 318 ms |

All four recalls completed within the app's 700 ms deadline. Container memory during ingestion was about
1.74 GiB. These four constructed queries do not measure general accuracy, false positives, cold starts, p95
latency or end-to-end response quality. The test used synthetic data only, then deleted its source documents.

## Try it in Roamies

### Reuse the Roamies ChatGPT provider

From the sidecar directory, run:

```powershell
node hindsight-provider.mjs
```

This starts an authenticated, text-only provider bridge on `127.0.0.1:9078` and the dedicated Docker Compose
deployment. Keep the process running. It reads the selected provider/model from Roamies' configuration and uses
the same `AuthStorage.resolveCredentials` path as the app for each inference request. Currently this bridge
supports the public Responses API ChatGPT sign-in only; other providers fail closed. It neither copies nor
hands Hindsight the ChatGPT access/refresh tokens. Hindsight receives only a random bridge key, recreated on
each launch. The bridge pins inference to the selected model and official API origin, refuses tools and images,
uses `store: false`, and does not log prompts, responses or credentials. Usage counts against the existing plan.
If the sign-in is revoked or inference is rejected, requests fail without a second credential owner refreshing
an independent token copy. Docker Desktop must be able to reach host loopback through `host.docker.internal`.

The bridge and container run separately from the app. Restart the bridge if you change the selected Roamies model.
Stopping it leaves the container running but unable to perform inference; stop that container too when the trial
is finished. The temporary bridge key appears in Docker's container configuration, but the ChatGPT tokens do not.

### Enable retrieval in the app

Build the modified app normally, then enable **Memory → Hindsight memory**. No environment variable is required
for the default local server. The switch saves `hindsight: true/false` in Roamies' settings, with explicit false
taking priority over any developer environment flag. Off immediately stops future retrieval/indexing and
discards results still in flight; an already-sent retain may finish on the server. It keeps the existing local
and Hindsight data. Turning on resumes indexing and cleanup against the current facts.

For developer overrides, set `ROAMIES_HINDSIGHT_URL` before launching Roamies and restart to inherit it. If the UI
choice has never been saved, the presence of this variable retains the earlier opt-in behavior.
Only literal loopback HTTP origins (`127.0.0.1` or `[::1]`) are accepted. Remote services, DNS hostnames,
embedded credentials, paths, query strings, and redirects are refused. No Hindsight client dependency is bundled.

Facts index in background batches of ten. Early requests may fall back while indexing finishes. Each normal
request has a 700 ms recall deadline. The newest eight facts remain available, followed by Hindsight matches,
then lexical fallback, with a total of forty. A Hindsight result must name a current local source document;
Roamies inserts the approved local text rather than Hindsight's generated text. Observations and reflect are
excluded in this stage. With forty or fewer facts, this trial will have little effect on which facts fit.

Logs contain `hindsight_synced`, `hindsight_recall` (duration and matched count), and `hindsight_failed`
(operation only), never query text, fact text, or backend error bodies. Compare offline fallbacks and real p95
latency as well as successful retrieval. Expand to conversation memory only after this comparison is useful.

## Forgetting and rollback

Each local store/endpoint has a fresh, dedicated bank recorded in `hindsight-<hash>.json` under the sidekick data
directory. This manifest contains document hashes and ingestion status, not copies of fact text or credentials.
Do not delete it until remote cleanup finishes. Do not sync a live Hindsight database through the memory-sync
folder. Each computer independently indexes the facts it receives through Roamies' existing sync.

While the switch is on, forgetting, replacing, clearing, and synced removals trigger document cleanup. Failed
cleanup retries every 30 seconds and after an enabled restart, using the persisted manifest. If you forget facts
while the switch is off, their Hindsight copies are cleaned up the next time it is enabled; use the dedicated
bank's delete action to erase those copies without resuming the trial. Current local facts filter every recall, including
results that were already in flight, so a removed source cannot re-enter the prompt while deletion is pending.
Backend document deletion and derivation handling are provided by Hindsight; verify them against your pinned
version before expanding this pilot to generated observations. No remote data is purged merely by disabling it.
If a retain request times out, the server may still be processing it; wait for backend processing to finish and
verify deletion in the dedicated bank before treating physical erasure as complete. Local recall exclusion is
immediate regardless of backend processing.

To disable retrieval, turn off **Hindsight memory** on the Memory page. Local memory keeps working. To also remove
trial data, use Hindsight's UI at `http://127.0.0.1:9999` to delete the dedicated bank shown in the manifest, or
stop the dedicated Compose deployment and remove its named volume when you intend to erase all its contents.
Don't remove a volume shared with unrelated Hindsight data.

## Checks

`npm test` includes an isolated HTTP contract test covering indexing, duplicate prevention, semantic selection,
timeouts, redirects, secret filtering, failed deletion, restart recovery, and store notifications. That fixture
does not test Hindsight's extraction or retrieval quality. The setup script's `--check` verifies the real service's health.
