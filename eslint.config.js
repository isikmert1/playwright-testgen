const js = require('@eslint/js');
const globals = require('globals');

module.exports = [
  { ignores: ['vendor/'] },
  js.configs.recommended,
  {
    files: ['**/*.{cjs,js,mjs}'],
    languageOptions: {
      globals: globals.node,
    },
  },
  {
    files: ['**/*.cjs'],
    rules: {
      'array-callback-return': 'error',
      eqeqeq: ['error', 'always', { null: 'ignore' }],
      'no-constructor-return': 'error',
      'no-eval': 'error',
      'no-extend-native': 'error',
      'no-implied-eval': 'error',
      'no-nested-ternary': 'error',
      'no-new-func': 'error',
      'no-new-wrappers': 'error',
      'no-param-reassign': ['error', { props: false }],
      'no-proto': 'error',
      'no-return-assign': ['error', 'always'],
      'no-self-compare': 'error',
      'no-sequences': 'error',
      'no-shadow': 'error',
      'no-throw-literal': 'error',
      'no-unneeded-ternary': 'error',
      'no-unreachable-loop': 'error',
      'no-unsafe-optional-chaining': [
        'error',
        { disallowArithmeticOperators: true },
      ],
      'no-var': 'error',
      'prefer-const': 'error',
      'prefer-promise-reject-errors': 'error',
      'require-atomic-updates': ['error', { allowProperties: true }],
    },
  },
  {
    files: ['evals/targets/**/public/**/*.js'],
    languageOptions: {
      globals: globals.browser,
    },
  },
];
