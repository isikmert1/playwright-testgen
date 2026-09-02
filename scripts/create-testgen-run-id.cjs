#!/usr/bin/env node

const { randomBytes } = require('node:crypto');

process.stdout.write(`tg-${randomBytes(12).toString('hex')}\n`);
