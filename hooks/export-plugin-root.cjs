const { appendFileSync } = require('node:fs');
const path = require('node:path');

function shellQuote(value) {
  return `'${value.replaceAll("'", `'"'"'`)}'`;
}

function exportPluginRoot(environment = process.env) {
  if (!environment.CLAUDE_ENV_FILE)
    throw new Error('CLAUDE_ENV_FILE is unavailable');

  const pluginRoot = path.resolve(__dirname, '..').replaceAll('\\', '/');
  appendFileSync(
    environment.CLAUDE_ENV_FILE,
    `export PLAYWRIGHT_TESTGEN_ROOT=${shellQuote(pluginRoot)}\n`,
    'utf8',
  );
}

if (require.main === module) exportPluginRoot();

module.exports = { exportPluginRoot, shellQuote };
