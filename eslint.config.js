const js = require('@eslint/js');
const globals = require('globals');

module.exports = [
  js.configs.recommended,
  {
    files: ['**/*.{cjs,js,mjs}'],
    languageOptions: {
      globals: globals.node,
    },
  },
  {
    files: ['evals/targets/**/public/**/*.js'],
    languageOptions: {
      globals: globals.browser,
    },
  },
];
