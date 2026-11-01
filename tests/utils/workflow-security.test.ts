import { expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';

const yaml = (Bun as unknown as { YAML: { parse(text: string): unknown } }).YAML;
const workflow = yaml.parse(
  readFileSync(new URL('../../.github/workflows/claude-review.yml', import.meta.url), 'utf8')
) as {
  jobs: {
    review: {
      environment: { name: string };
      steps: { name?: string; run?: string }[];
    };
  };
};

test('review credentials are limited to trusted workflow contexts', () => {
  const expression = workflow.jobs.review.environment.name.trim().slice(3, -2).trim();
  // Checked-in expression text is trusted; event values are passed as data.
  const choose = new Function('github', `return (${expression});`);
  for (const fixture of [
    { event: 'pull_request', expected: true },
    { event: 'pull_request', fork: true },
    { event: 'pull_request', draft: true },
    { event: 'pull_request', actor: 'dependabot[bot]' },
    { event: 'pull_request_target' },
    { event: 'issue_comment' },
    { event: 'push', main: true, noPR: true, expected: true },
    { event: 'workflow_dispatch', main: true, noPR: true, expected: true },
    { event: 'workflow_dispatch', noPR: true },
  ]) {
    const result = choose({
      event_name: fixture.event,
      actor: fixture.actor ?? 'unit-test-owner',
      repository: 'unit-test/server',
      ref: fixture.main ? 'refs/heads/main' : 'refs/pull/1/merge',
      event: {
        pull_request: {
          draft: fixture.draft ?? false,
          head: {
            repo: {
              full_name: fixture.noPR ? '' : fixture.fork ? 'outsider/server' : 'unit-test/server',
            },
          },
        },
      },
    });
    expect(result).toBe(fixture.expected ? 'security-ci-claude' : 'security-ci-untrusted');
  }
});

test('missing review authentication fails before checkout and never prints a token', () => {
  const step = workflow.jobs.review.steps[0]!;
  expect(step.name).toBe('Require Claude CI authentication');
  for (const token of ['', 'unit-test-not-a-credential']) {
    const result = spawnSync(
      'bash',
      ['--noprofile', '--norc', '-eo', 'pipefail', '-c', step.run!],
      {
        env: { PATH: process.env.PATH, CLAUDE_CI_TOKEN: token },
        encoding: 'utf8',
        timeout: 5000,
      }
    );
    expect(result.error).toBeUndefined();
    expect(result.status).toBe(token ? 0 : 1);
    expect(result.stdout + result.stderr).not.toContain('unit-test-not-a-credential');
  }
});
