// @vitest-environment node
/**
 * The pure parts of the GitHub integration (iteration-2 contract §C): link rules, pull request URLs, webhook
 * signatures and CI state folding.
 */
import { createHmac } from 'node:crypto';

import { describe, expect, it } from 'vitest';

import {
  ciStateOfCheckSuite,
  combineCiStates,
} from '../../server/modules/git/github-client.ts';
import {
  matchIssueIdentifiers,
  parsePullRequestUrl,
} from '../../server/modules/git/link-rules.ts';
import { verifySignature } from '../../server/modules/git/webhook.service.ts';

describe('link rules and URLs (pure)', () => {
  const rule = (headRef: string, title = '', body: string | null = null) =>
    matchIssueIdentifiers({ headRef, title, body, prefix: 'NP' });

  it('takes the issue from an agent branch first', () => {
    expect(rule('agent/np-145', 'Fixes NP-3')).toEqual({
      rule: 'branch',
      identifiers: ['NP-145'],
    });
    expect(rule('agent/echo/np-12', 'Fixes NP-3')).toEqual({
      rule: 'branch',
      identifiers: ['NP-12'],
    });
    expect(rule('agent/claude-code/NP-7')).toEqual({
      rule: 'branch',
      identifiers: ['NP-7'],
    });
    expect(rule('agent/a/b/np-7', 'NP-3')).toEqual({
      rule: 'mention',
      identifiers: ['NP-3', 'NP-7'],
    });
  });

  it('collects issue numbers from title, body and branch, deduplicated, at most five', () => {
    expect(
      rule('feature/np-2-login', 'NP-1: login', 'Also np-1 and NP-3.'),
    ).toEqual({
      rule: 'mention',
      identifiers: ['NP-1', 'NP-3', 'NP-2'],
    });
    expect(rule('x', 'NP-1 NP-2 NP-3 NP-4 NP-5 NP-6').identifiers).toHaveLength(
      5,
    );
    expect(rule('x', 'SNP-1 NP-12a notNP-3')).toEqual({
      rule: 'none',
      identifiers: [],
    });
    expect(
      matchIssueIdentifiers({
        headRef: 'agent/a/dev-4',
        title: '',
        body: null,
        prefix: 'DEV',
      }),
    ).toEqual({
      rule: 'branch',
      identifiers: ['DEV-4'],
    });
  });

  it('parses pull request URLs', () => {
    expect(
      parsePullRequestUrl('https://github.com/acme/app/pull/42/files?x=1'),
    ).toMatchObject({
      repo: 'acme/app',
      number: 42,
      url: 'https://github.com/acme/app/pull/42',
    });
    expect(
      parsePullRequestUrl('https://ghe.example.com/a/b/pull/7')?.repo,
    ).toBe('a/b');
    for (const bad of [
      'https://github.com/acme/app/issues/4',
      'not a url',
      42,
      'https://github.com/a/pull/1',
    ])
      expect(parsePullRequestUrl(bad)).toBeNull();
  });

  it('verifies signatures in constant time and folds CI states', () => {
    const body = Buffer.from('{"a":1}');
    const good = `sha256=${createHmac('sha256', 's3cret').update(body).digest('hex')}`;
    expect(verifySignature('s3cret', body, good)).toBe(true);
    expect(verifySignature('other', body, good)).toBe(false);
    expect(verifySignature('s3cret', body, null)).toBe(false);
    expect(verifySignature('s3cret', body, 'sha256=00')).toBe(false);
    expect(combineCiStates([null, 'success', 'pending'])).toBe('pending');
    expect(combineCiStates(['success', 'failure'])).toBe('failure');
    expect(combineCiStates([null])).toBeNull();
  });

  it('ignores check suites without check runs (NP-195)', () => {
    // A GitHub App's empty suite stays queued forever; GitHub's own pages skip it.
    expect(
      ciStateOfCheckSuite({
        status: 'queued',
        conclusion: null,
        latest_check_runs_count: 0,
      }),
    ).toBeNull();
    for (const status of ['queued', 'in_progress'])
      expect(
        ciStateOfCheckSuite({
          status,
          conclusion: null,
          latest_check_runs_count: 1,
        }),
      ).toBe('pending');
    // Without the count (older payloads) the suite still counts.
    expect(ciStateOfCheckSuite({ status: 'queued', conclusion: null })).toBe(
      'pending',
    );
    expect(
      ciStateOfCheckSuite({
        status: 'completed',
        conclusion: 'success',
        latest_check_runs_count: 2,
      }),
    ).toBe('success');
    expect(ciStateOfCheckSuite(undefined)).toBeNull();
  });
});
