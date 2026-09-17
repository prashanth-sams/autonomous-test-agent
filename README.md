# Autonomous Exploratory Testing Agent

One shared exploratory-testing core with platform-specific executors. **The web
agent (Playwright) is implemented**; mobile and desktop executors plug into the
same core by implementing one interface.

The agent opens the real application, navigates workflows, changes state,
explores unexpected paths, and records defects that it has replayed from a clean
start before reporting them.

## Architecture

```
apps/web-agent            CLI product: explore a site, or test a pull request
packages/shared-contracts Types every layer agrees on (no platform code)
packages/agent-core       The shared intelligence — see below
executors/web-playwright  Web executor: DOM/a11y, network, console, traces
examples/demo-app         A deliberately buggy shop used to evaluate the agent
```

`agent-core` never imports platform code. It talks to the application through
one seam:

```ts
interface PlatformExecutor {
  start(): Promise<void>;
  observe(): Promise<ApplicationState>;
  availableActions(state: ApplicationState): Promise<Action[]>;
  execute(action: Action): Promise<ActionResult>;
  runScriptedStep(step: ScriptedStep): Promise<ActionResult>;
  captureEvidence(label: string): Promise<EvidenceRef[]>;
  drainObservations(): Observation[];
  reset(): Promise<void>;
  stop(): Promise<void>;
}
```

A mobile (Appium) or desktop (UI Automation / macOS Accessibility) executor
implements the same interface — planning, memory, oracles, defect handling and
reporting are reused unchanged.

### What the core does

| Component | Responsibility |
| --- | --- |
| `StateMemory` | State graph, visit counts, what has been tried, the journey walked |
| `CoverageTracker` | Routes, states, elements and actions actually exercised |
| `RiskEngine` | Scores each candidate action, and records *why* — every choice is explainable |
| `Planner` | Picks the next action (deterministic heuristic planner; the interface allows an AI planner) |
| Oracles | Decide what counts as wrong (see below) |
| `DefectRepository` | Fingerprints, deduplicates, scores confidence, suppresses known false positives |
| `DefectVerifier` | Replays each candidate from a clean state before it is reported |
| `SafetyPolicy` | Blocks destructive and prohibited actions, confines navigation, redacts secrets |
| `analyzeImpact` | Turns a PR diff into targeted missions with a confidence score |
| Reporting | `run.json`, a PR-ready `report.md` and a self-contained `report.html` |

### Test oracles

Navigation is not the hard part; knowing what is wrong is. The agent detects
automatically:

- page crashes and unhandled JavaScript exceptions
- failed HTTP requests (5xx always; 4xx unless configured as expected)
- broken links
- controls that accept a click and do nothing
- submits that produce no visible outcome
- empty screens, permanent spinners and error screens
- accessibility violations (axe-core, serious/critical only — opt in)

It cannot know whether a discount should be 10% or 20%, so business invariants
are configured:

```yaml
rules:
  - id: single-order-per-checkout
    description: An order must never be created twice for one checkout
    maxRequests: { method: POST, urlPattern: '/api/orders$', max: 1 }
    severity: critical

  - id: no-delete-for-viewers
    description: A viewer must not see the delete button
    route: /profile
    forbidElement: { role: button, name: delete }
```

### Trust rules built into the flow

- Every candidate defect is **replayed from a clean state**; only reproduced,
  high-severity findings can recommend blocking a merge.
- Verification replays use a **fresh request log**, so cumulative rules cannot
  "reproduce" themselves trivially.
- Every action is recorded, and every defect ships with steps, screenshots, DOM,
  console log, a Playwright trace and a **runnable `.spec.ts` reproduction**.
- The report states which journeys were selected **and why**, and which areas
  were **not tested**.
- Low impact confidence **broadens** the scope; it never silently narrows it.
- Critical journeys always run, whatever impact analysis suggests.
- Destructive actions are blocked by default; `advisory` mode is the default and
  cannot block a merge.

## Quick start

```bash
npm install
npm run build
npx playwright install chromium

# Terminal 1 — the deliberately buggy demo shop
node examples/demo-app/dist/server.js

# Terminal 2 — explore it
node apps/web-agent/dist/cli.js explore --config agent.example.yaml --max-steps 60
```

Against the demo app the agent finds all six seeded defects and reproduces each
one: duplicate order creation, an order booked on a declined card, an HTTP 500,
an unhandled exception, a dead "Apply coupon" button, and a broken Help link.

Reports land in `runs/<run-id>/`:

```
runs/run-.../report.md      PR comment / check summary
runs/run-.../report.html    self-contained run report
runs/run-.../run.json       machine-readable result
runs/run-.../artifacts/     screenshots, DOM, console log, trace.zip, DEF-*.spec.ts
```

## Testing a pull request

```bash
node apps/web-agent/dist/cli.js pr \
  --config agent.example.yaml \
  --base origin/main --head HEAD \
  --url https://preview-123.example.com
```

The diff is mapped to areas and journeys through `impactMap` in the config, in
three layers: deterministic critical journeys, impact mapping, then broadening
when confidence is low. The PR comment explains the selection:

```
| Area                | Confidence | Journeys                              |
| Checkout / Payments | 90%        | checkout, payment retry, declined card |
| Authentication      | 85%        | login, session expiry, logout          |
```

Exit codes: `0` pass, `1` review, `2` block, `3` agent error.
`.github/workflows/qa-agent.yml` wires this into GitHub Actions, uploads the
evidence directory and keeps a single updated PR comment.

## Use it as a GitHub Action

This repository is also a composite action, so another repository can run the
agent without vendoring any of it:

```yaml
name: QA Agent
on: pull_request

permissions:
  contents: read
  pull-requests: write

jobs:
  explore:
    runs-on: ubuntu-latest
    timeout-minutes: 20
    steps:
      - uses: actions/checkout@v4
        with:
          fetch-depth: 0 # impact analysis needs both sides of the diff

      - uses: prashanth-sams/autonomous-test-agent@v1
        with:
          url: ${{ vars.PREVIEW_URL }}
          config: qa/agent.yaml
          comment: 'true'
```

The action builds the agent and installs Chromium itself; the caller supplies a
running preview environment. Without `fetch-depth: 0` the agent cannot map the
diff to journeys and broadens the scope instead of narrowing it.

### Inputs

| Input | Default | Purpose |
| --- | --- | --- |
| `url` | *required* | Base URL of a test or preview environment — never production |
| `mode` | `pr` | `pr` for impact-driven testing, `explore` for a free exploratory run |
| `config` | — | Agent config path, relative to the caller's repository root |
| `base` / `head` | `origin/<base_ref>` / `github.sha` | Refs compared in `pr` mode |
| `changed-files` | — | Comma-separated paths, instead of running `git diff` |
| `max-steps` | — | Override the step budget from the config |
| `output-dir` | `qa-agent-runs` | Where reports and evidence are written |
| `blocking` | `false` | Allow a reproduced blocking defect to fail the job |
| `comment` | `false` | Post/update one PR comment (needs `pull-requests: write`) |
| `upload-artifact` | `true` | Upload the run directory as a workflow artifact |

### Outputs

| Output | Description |
| --- | --- |
| `result` | `pass`, `review`, `block` or `error` |
| `exit-code` | `0` pass, `1` review, `2` block, `3` agent error |
| `run-id` | Identifier of the completed run |
| `run-dir` | Absolute path to the run directory |
| `report-markdown` / `report-html` / `run-json` | Absolute path to each report |

The job fails only when the agent could not execute, or when `blocking: 'true'`
and a reproduced defect recommends blocking; a `review` result stays advisory.
The report is written to the job summary either way. Commenting is skipped for
pull requests from forks, whose tokens cannot write to the PR.

## Configuration

See [agent.example.yaml](agent.example.yaml). Key sections:

| Section | Purpose |
| --- | --- |
| `target` | Base URL and build identifier |
| `auth` | Deterministic login steps or a saved `storageState` |
| `criticalJourneys` | Always-run journeys, optionally fully scripted |
| `rules` | Business invariants the agent cannot infer |
| `limits` | Step, time and defect budgets; verification attempts |
| `safety` | Allowed hosts, prohibited/destructive actions, redaction keys |
| `impactMap` | Changed paths → area → journeys, with confidence |
| `oracles` | Which oracles run, and what noise to ignore |
| `knownFalsePositives` | Fingerprints humans dismissed in earlier runs |
| `mode` | `advisory` (default) or `blocking` |

## CLI

```
qa-web-agent explore [--url <baseUrl>] [--config agent.yaml] [options]
qa-web-agent pr      --base <ref> --head <ref> [--config agent.yaml] [options]

--max-steps <n>        Override the step budget
--headed               Run the browser headed
--browser <name>       chromium | firefox | webkit
--out <dir>            Output directory (default: runs)
--blocking             Allow the agent to recommend blocking a merge
--changed-files <a,b>  Explicit file list instead of running git diff
--json                 Print the run summary as JSON
```

## Tests

```bash
npm test
```

17 unit tests cover impact analysis, defect deduplication and confidence, the
merge recommendation, safety policy, risk scoring, and the oracles.

## Not built yet

Deliberately deferred, in the order the design calls for: mobile and desktop
executors, a GitHub App (the workflow uses the Actions token), an AI planner
behind the existing `Planner` interface, run history across executions, and
visual regression.
