#!/usr/bin/env node
// Bridges the composite action's inputs to the agent CLI.
//
// Two rules shape this file:
//   1. It always exits 0. The action's final step turns the recorded exit code
//      into a pass/fail, so the PR comment and evidence upload still run when
//      the agent reports a defect.
//   2. The CLI is invoked from the caller's workspace (so `git diff` and the
//      output directory resolve against their repository), but resolved from
//      the action's own checkout, where the build step ran.
import { spawnSync } from 'node:child_process';
import { appendFileSync, existsSync, readFileSync } from 'node:fs';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const workspace = process.env.GITHUB_WORKSPACE || process.cwd();
const actionPath =
  process.env.GITHUB_ACTION_PATH || dirname(dirname(fileURLToPath(import.meta.url)));

function input(name, fallback = '') {
  return (process.env[name] ?? '').trim() || fallback;
}

/** Values are single-line paths today; the delimiter form keeps that assumption safe. */
function setOutputs(outputs) {
  const file = process.env.GITHUB_OUTPUT;
  const rendered = Object.entries(outputs)
    .map(([key, value]) => {
      const text = String(value ?? '');
      const delimiter = `ghadelimiter_${key}_${Date.now()}`;
      return `${key}<<${delimiter}\n${text}\n${delimiter}\n`;
    })
    .join('');
  if (file) appendFileSync(file, rendered, 'utf8');
  else process.stdout.write(rendered);
}

function fail(message) {
  process.stderr.write(`${message}\n`);
  setOutputs({
    result: 'error',
    'exit-code': '3',
    'run-id': '',
    'run-dir': '',
    'report-markdown': '',
    'report-html': '',
    'run-json': '',
  });
  // The enforce step fails the job on exit code 3; failing here would skip it.
  process.exit(0);
}

const cli = join(actionPath, 'apps', 'web-agent', 'dist', 'cli.js');
if (!existsSync(cli)) {
  fail(`Agent CLI not found at ${cli}. The action's build step did not complete.`);
}

const mode = input('AGENT_MODE', 'pr');
if (mode !== 'pr' && mode !== 'explore') {
  fail(`Unsupported mode "${mode}"; expected "pr" or "explore".`);
}

const url = input('AGENT_URL');
if (!url) fail('Input "url" is required.');

const rawOutputDir = input('AGENT_OUTPUT_DIR', 'qa-agent-runs');
const outputDir = isAbsolute(rawOutputDir) ? rawOutputDir : resolve(workspace, rawOutputDir);

const args = [cli, mode, '--url', url, '--out', outputDir, '--json'];

const configInput = input('AGENT_CONFIG');
if (configInput) {
  const configPath = isAbsolute(configInput) ? configInput : resolve(workspace, configInput);
  if (!existsSync(configPath)) {
    fail(`Config file not found: ${configPath} (input "config" is relative to the repository root).`);
  }
  args.push('--config', configPath);
}

const maxSteps = input('AGENT_MAX_STEPS');
if (maxSteps) {
  if (!/^\d+$/.test(maxSteps) || Number(maxSteps) === 0) {
    fail(`Input "max-steps" must be a positive integer; received "${maxSteps}".`);
  }
  args.push('--max-steps', maxSteps);
}

if (input('AGENT_BLOCKING') === 'true') args.push('--blocking');

if (mode === 'pr') {
  const baseRef = input('AGENT_BASE_REF');
  const base = input('AGENT_BASE', baseRef ? `origin/${baseRef}` : 'origin/main');
  const head = input('AGENT_HEAD', input('AGENT_SHA', 'HEAD'));
  args.push('--base', base, '--head', head);

  const changedFiles = input('AGENT_CHANGED_FILES');
  if (changedFiles) args.push('--changed-files', changedFiles);
}

process.stderr.write(`Running: node ${args.slice(1).join(' ')}\n`);

const child = spawnSync(process.execPath, args, {
  cwd: workspace,
  // The run summary arrives on stdout; the agent's progress log goes straight to the job log.
  stdio: ['ignore', 'pipe', 'inherit'],
  encoding: 'utf8',
  maxBuffer: 64 * 1024 * 1024,
});

if (child.error) fail(`Failed to start the agent: ${child.error.message}`);
if (child.signal) fail(`The agent was terminated by signal ${child.signal}.`);

const exitCode = child.status ?? 3;
let summary;
try {
  summary = JSON.parse(child.stdout ?? '');
} catch {
  const tail = (child.stdout ?? '').slice(-2000);
  fail(`The agent exited ${exitCode} without a parsable run summary.${tail ? `\n${tail}` : ''}`);
}

// The CLI reports where it wrote; the joins only cover an older build.
const runDir = summary.runDir ?? join(outputDir, summary.runId);
const reports = summary.reports ?? {
  markdown: join(runDir, 'report.md'),
  html: join(runDir, 'report.html'),
  json: join(runDir, 'run.json'),
};
const pathIfWritten = (candidate) => (candidate && existsSync(candidate) ? candidate : '');

const result = exitCode === 3 ? 'error' : summary.recommendation ?? 'error';
const markdown = pathIfWritten(reports.markdown);

setOutputs({
  result,
  'exit-code': String(exitCode),
  'run-id': summary.runId ?? '',
  'run-dir': pathIfWritten(runDir),
  'report-markdown': markdown,
  'report-html': pathIfWritten(reports.html),
  'run-json': pathIfWritten(reports.json),
});

// Surface the report on the job summary page, where a reviewer already is.
if (markdown && process.env.GITHUB_STEP_SUMMARY) {
  appendFileSync(process.env.GITHUB_STEP_SUMMARY, `${readFileSync(markdown, 'utf8')}\n`, 'utf8');
}

process.stderr.write(`Agent recommendation: ${result} (exit code ${exitCode})\n`);
process.exit(0);
