/**
 * The package is ESM and its sources use ESM-style `./foo.js` specifiers, which
 * Jest cannot resolve natively without the experimental VM modules flag. So
 * ts-jest transpiles the tests down to CJS and the mapper below strips the
 * extension back off — no flag, no ESM/CJS interop surprises.
 */
export default {
  testEnvironment: 'node',
  roots: ['<rootDir>/src'],
  transform: {
    '^.+\\.ts$': [
      'ts-jest',
      {
        tsconfig: {
          module: 'CommonJS',
          moduleResolution: 'Node10',
          verbatimModuleSyntax: false,
        },
      },
    ],
  },
  moduleNameMapper: { '^(\\.{1,2}/.*)\\.js$': '$1' },
  clearMocks: true,
  restoreMocks: true,
  collectCoverageFrom: [
    'src/**/*.ts',
    '!src/**/*.test.ts',
    '!src/test-helpers.ts',
    '!src/cli.ts',
    '!src/version.ts',
  ],
  coverageReporters: ['text-summary', 'lcov'],
};
