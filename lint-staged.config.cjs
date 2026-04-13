/** @type {import('lint-staged').Configuration} */
module.exports = {
  'frontend/**/*.{ts,tsx}': () => 'yarn workspace frontend run lint',
};
