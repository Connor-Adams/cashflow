require('dotenv').config();
const path = require('path');

const storage =
  process.env.DATABASE_PATH ||
  path.join(__dirname, 'data', 'cashflow.sqlite');

function configFor(envName) {
  if (envName === 'test') {
    return {
      dialect: 'sqlite',
      storage: ':memory:',
      logging: false,
    };
  }

  if (process.env.DATABASE_URL) {
    return {
      url: process.env.DATABASE_URL,
      dialect: 'postgres',
      logging: false,
    };
  }

  return {
    dialect: 'sqlite',
    storage,
    logging: false,
  };
}

module.exports = {
  development: configFor('development'),
  test: configFor('test'),
  production: configFor('production'),
};
