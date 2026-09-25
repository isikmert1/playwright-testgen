const assert = require('node:assert/strict');
const test = require('node:test');
const {
  scorePlaywrightReport,
} = require('../scripts/run-generation-candidate.cjs');

function report(status) {
  return {
    errors: [],
    stats: {
      expected: status === 'passed' ? 1 : 0,
      unexpected: status === 'failed' ? 1 : 0,
      skipped: 0,
      flaky: 0,
    },
    suites: [
      {
        specs: [
          {
            tests: [
              {
                status: status === 'passed' ? 'expected' : 'unexpected',
                results: [{ status }],
              },
            ],
          },
        ],
      },
    ],
  };
}

test('candidate grader distinguishes a passing spec from an assertion failure', () => {
  assert.equal(scorePlaywrightReport(report('passed')), 'pass');
  assert.equal(scorePlaywrightReport(report('failed')), 'fail');
  assert.equal(
    scorePlaywrightReport({ ...report('passed'), errors: [{}] }),
    'error',
  );
  assert.equal(
    scorePlaywrightReport({ ...report('passed'), stats: { expected: 2 } }),
    'error',
  );
});
