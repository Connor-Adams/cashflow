const { Sequelize } = require('sequelize');
const fs = require('fs');
const path = require('path');
const env = require('./config/env');

const dir = path.dirname(env.databasePath);
if (!fs.existsSync(dir)) {
  fs.mkdirSync(dir, { recursive: true });
}

const sequelize = new Sequelize({
  dialect: 'sqlite',
  storage: env.databasePath,
  logging: env.nodeEnv === 'development' ? false : false,
});

module.exports = { sequelize };
