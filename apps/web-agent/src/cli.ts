#!/usr/bin/env node
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import type { AgentConfig } from '@qa-agent/shared-contracts';
import { loadConfig } from './config';
import { runWebAgent } from './run';

interface Flags {
  [key: string]: string | boolean;
}

const USAGE = `Autonomous Web Testing Agent

Usage:
  qa-web-agent explore [--url <baseUrl>] [--config agent.yaml] [options]
  qa-web-agent pr      --base <ref> --head <ref> [--config agent.yaml] [options]

Options:
  --url <url>          Base URL of the application under test
  --config <path>      YAML/JSON agent config (see agent.example.yaml)
  --max-steps <n>      Override the step budget
  --headed             Run the browser headed
  --browser <name>     chromium | firefox | webkit
  --out <dir>          Output directory for runs (default: runs)
  --blocking           Allow the agent to recommend blocking a merge
  --changed-files <a,b>  Explicit file list instead of running git diff
  --quiet              Only print the final summary
  --json               Print the run summary as JSON on stdout

Exit codes: 0 pass, 1 review, 2 block, 3 agent error.
`;

async function main(): Promise<number> {
  const [command, ...rest] = process.argv.slice(2);
  if (!command || command === 'help' || command === '--help') {
    process.stdout.write(USAGE);
    return 0;
  }

  const flags = parseFlags(rest);
  const overrides = buildOverrides(flags);
  const config = loadConfig(
    typeof flags.config === 'string' ? flags.config : undefined,
    overrides,
  );

  switch (command) {
    case 'explore':
      return report(await runWebAgent({ config, quiet: Boolean(flags.quiet) }), flags);
    case 'pr': {
      const base = String(flags.base ?? 'origin/main');
      const head = String(flags.head ?? 'HEAD');
      const changedFiles =
        typeof flags['changed-files'] === 'string'
          ? String(flags['changed-files']).split(',').map((file) => file.trim()).filter(Boolean)
          : gitChangedFiles(base, head);
      return report(
        await runWebAgent({ config, diff: { base, head, changedFiles }, quiet: Boolean(flags.quiet) }),
        flags,
      );
    }
    default:
      process.stderr.write(`Unknown command: ${command}\n\n${USAGE}`);
      return 3;
  }
}

function report(output: Awaited<ReturnType<typeof runWebAgent>>, flags: Flags): number {
  const { summary } = output;
  if (flags.json) {
    process.stdout.write(`${JSON.stringify(summary, null, 2)}\n`);
  } else {
    process.stdout.write(`\n${readFileSync(output.reports.markdown, 'utf8')}\n`);
    process.stdout.write(`\nReports: ${output.reports.html}\n`);
  }
  // CI reads the exit code; the report explains it.
  return summary.recommendation === 'pass' ? 0 : summary.recommendation === 'review' ? 1 : 2;
}

function buildOverrides(flags: Flags): Partial<AgentConfig> {
  const overrides: Record<string, unknown> = {};
  if (typeof flags.url === 'string') overrides.target = { baseUrl: flags.url };
  if (typeof flags['max-steps'] === 'string') {
    overrides.limits = { maxSteps: Number(flags['max-steps']) };
  }
  if (flags.headed || typeof flags.browser === 'string') {
    overrides.browser = {
      ...(flags.headed ? { headless: false } : {}),
      ...(typeof flags.browser === 'string' ? { name: flags.browser } : {}),
    };
  }
  if (typeof flags.out === 'string') overrides.reporting = { outputDir: flags.out };
  if (flags.blocking) overrides.mode = 'blocking';
  return overrides as Partial<AgentConfig>;
}

function gitChangedFiles(base: string, head: string): string[] {
  try {
    const output = execFileSync('git', ['diff', '--name-only', `${base}...${head}`], {
      encoding: 'utf8',
    });
    return output.split('\n').map((line) => line.trim()).filter(Boolean);
  } catch (error) {
    process.stderr.write(
      `git diff ${base}...${head} failed (${(error as Error).message}); ` +
        'continuing with an empty diff, which broadens the exploration scope.\n',
    );
    return [];
  }
}

function parseFlags(argv: string[]): Flags {
  const flags: Flags = {};
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (!token?.startsWith('--')) continue;
    const key = token.slice(2);
    const next = argv[index + 1];
    if (next && !next.startsWith('--')) {
      flags[key] = next;
      index += 1;
    } else {
      flags[key] = true;
    }
  }
  return flags;
}

main()
  .then((code) => {
    process.exitCode = code;
  })
  .catch((error: Error) => {
    process.stderr.write(`Agent error: ${error.stack ?? error.message}\n`);
    process.exitCode = 3;
  });
