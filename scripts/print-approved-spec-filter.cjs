const quote = require('../vendor/shell-quote/quote');
const { loadPolicy, RUN_ID } = require('../hooks/run-policy.cjs');

function main([runId]) {
  if (!RUN_ID.test(runId ?? '')) throw new Error('invalid run ID');

  const policy = loadPolicy(process.cwd(), runId);
  if (policy == null) throw new Error('run policy unavailable');

  process.stdout.write(`${quote([policy.approvedSpecFilter])}\n`);
}

if (require.main === module) main(process.argv.slice(2));

module.exports = { main };
