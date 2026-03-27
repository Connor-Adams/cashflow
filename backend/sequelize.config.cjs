require('dotenv').config();
const path = require('path');

const storage =
  process.env.DATABASE_PATH ||
  path.join(__dirname, 'data', 'cashflow.sqlite');

module.exports = {
  development: {
    dialect: 'sqlite',
    storage,
    logging: false,
  },
  test: {
    dialect: 'sqlite',
    storage: ':memory:',
    logging: false,
  },
  production: {
    dialect: 'sqlite',
    storage,
    logging: false,
  },
};
