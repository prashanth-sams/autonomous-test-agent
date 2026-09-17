import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { RunSummary } from '@qa-agent/shared-contracts';
import { toHtml } from './html';
import { toMarkdown } from './markdown';

export interface WrittenReport {
  json: string;
  markdown: string;
  html: string;
}

export function writeReports(summary: RunSummary, runDir: string): WrittenReport {
  const json = join(runDir, 'run.json');
  const markdown = join(runDir, 'report.md');
  const html = join(runDir, 'report.html');
  writeFileSync(json, JSON.stringify(summary, null, 2), 'utf8');
  writeFileSync(markdown, toMarkdown(summary), 'utf8');
  writeFileSync(html, toHtml(summary), 'utf8');
  return { json, markdown, html };
}

export { toHtml, toMarkdown };
