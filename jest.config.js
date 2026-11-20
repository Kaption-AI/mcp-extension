module.exports = {
  preset: 'ts-jest',
  testEnvironment: 'node',
  roots: ['<rootDir>/src'],
  testMatch: ['**/__tests__/**/*.test.ts'],
  moduleFileExtensions: ['ts', 'js', 'json'],
  // mcp-apps-cards.FLAG.1 — tests never ask the real flags worker (cards tests pass their own flag).
  setupFiles: ['<rootDir>/jest.setup.js'],
};
