require('./settings');
const fs = require('fs');
const pino = require('pino');
const path = require('path');
const axios = require('axios');
const chalk = require('chalk');
const express = require('express');
const readline = require('readline');
const { createServer } = require('http');
const { Boom } = require('@hapi/boom');
const NodeCache = require('node-cache');
const { toBuffer, toDataURL } = require('qrcode');
const { exec, spawn, execSync } = require('child_process');
const { parsePhoneNumber } = require('awesome-phonenumber');
const { default: WAConnection, useMultiFileAuthState, Browsers, DisconnectReason, makeInMemoryStore, makeCacheableSignalKeyStore, fetchLatestBaileysVersion, proto } = require('baileys');

const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
const question = (text) => new Promise((resolve) => rl.question(text, resolve));
let app = express();
let server = createServer(app);
let PORT = process.env.PORT || 3000;
let pairingStarted = false;

const DataBase = require('./src/database');
const packageInfo = require('./package.json');
const database = new DataBase(global.tempatDB);
const msgRetryCounterCache = new NodeCache();
const groupCache = new NodeCache({ stdTTL: 5 * 60, useClones: false });

app.get('/', (req, res) => {
  if (process.send) {
    process.send('uptime');
    process.once('message', (uptime) => {
      res.json({
        bot_name: packageInfo.name,
        version: packageInfo.version,
        author: packageInfo.author,
        description: packageInfo.description,
        uptime: `${Math.floor(uptime)} seconds`
      });
    });
  } else {
    res.json({ error: 'Process not running with IPC' });
  }
});

server.listen(PORT, () => {
  console.log('App listening on port', PORT);
});

// Handle the Bot Logic
async function startNazeBot() {
  const store = makeInMemoryStore({ logger: pino().child({ level: 'silent', stream: 'store' }) });
  const { state, saveCreds } = await useMultiFileAuthState('nazedev');
  const { version, isLatest } = await fetchLatestBaileysVersion();
  const level = pino({ level: 'silent' });

  try {
    const loadData = await database.read();
    global.db = loadData && Object.keys(loadData).length !== 0 ? loadData : {
      hit: {},
      set: {},
      users: {},
      game: {},
      groups: {},
      database: {},
      premium: [],
      sewa: []
    };
    await database.write(global.db);

    setInterval(async () => {
      if (global.db) await database.write(global.db);
    }, 30 * 1000);
  } catch (e) {
    console.error(e);
    process.exit(1);
  }

  const getMessage = async (key) => {
    if (store) {
      const msg = await store.loadMessage(key.remoteJid, key.id);
      return msg?.message || { conversation: 'Halo Saya Naze Bot' };
    }
    return { conversation: 'Halo Saya Naze Bot' };
  };

  const naze = WAConnection({
    logger: level,
    getMessage,
    syncFullHistory: true,
    maxMsgRetryCount: 15,
    msgRetryCounterCache,
    retryRequestDelayMs: 10,
    connectTimeoutMs: 60000,
    printQRInTerminal: true,
    defaultQueryTimeoutMs: undefined,
    browser: Browsers.ubuntu('Chrome'),
    generateHighQualityLinkPreview: true,
    cachedGroupMetadata: async (jid) => groupCache.get(jid),
    transactionOpts: {
      maxCommitRetries: 10,
      delayBetweenTriesMs: 10,
    },
    auth: {
      creds: state.creds,
      keys: makeCacheableSignalKeyStore(state.keys, level),
    },
  });

  store.bind(naze.ev);

  naze.ev.on('creds.update', saveCreds);

  naze.ev.on('connection.update', async (update) => {
    const { qr, connection, lastDisconnect, isNewLogin, receivedPendingNotifications } = update;
    if (qr) {
      app.use('/qr', async (req, res) => {
        res.setHeader('content-type', 'image/png');
        res.end(await toBuffer(qr));
      });
    }
    if (isNewLogin) console.log(chalk.green('New device login detected...'));
    if (receivedPendingNotifications === 'true') {
      console.log('Please wait About 1 Minute...');
      naze.ev.flush();
    }

    if (connection === 'close') {
      const reason = new Boom(lastDisconnect?.error)?.output.statusCode;
      if ([DisconnectReason.connectionLost, DisconnectReason.connectionClosed, DisconnectReason.restartRequired].includes(reason)) {
        console.log('Connection lost or closed, Reconnecting...');
        startNazeBot();
      } else if (reason === DisconnectReason.loggedOut) {
        console.log('Scan again and Run...');
        exec('rm -rf ./nazedev/*');
        process.exit(1);
      } else {
        naze.end(`Unknown DisconnectReason : ${reason}|${connection}`);
      }
    }

    if (connection === 'open') {
      console.log('Connected to : ' + JSON.stringify(naze.user, null, 2));
    }
  });

  naze.ev.on('call', async (call) => {
    if (global.db?.set[naze.user.id]?.anticall) {
      for (let id of call) {
        if (id.status === 'offer') {
          let msg = await naze.sendMessage(id.from, {
            text: `Saat ini kami tidak dapat menerima panggilan ${id.isVideo ? 'Video' : 'Suara'}.`,
            mentions: [id.from],
          });
          await naze.sendContact(id.from, global.owner, msg);
          await naze.rejectCall(id.id, id.from);
        }
      }
    }
  });

  naze.ev.on('messages.upsert', async (message) => {
    await MessagesUpsert(naze, message, store, groupCache);
  });

  setInterval(async () => {
    await naze.sendPresenceUpdate('available', naze.decodeJid(naze.user.id)).catch(e => {});
  }, 10 * 60 * 1000);

  return naze;
}

startNazeBot();

// Process Exit Handling
process.on('exit', async () => {
  if (global.db) await database.write(global.db);
  console.log('Cleaning up... Closing server.');
  server.close(() => {
    console.log('Server closed successfully.');
  });
});

process.on('SIGINT', async () => {
  if (global.db) await database.write(global.db);
  console.log('Received SIGINT. Closing server...');
  server.close(() => {
    console.log('Server closed. Exiting process.');
    process.exit(0);
  });
});

server.on('error', (error) => {
  if (error.code === 'EADDRINUSE') {
    console.log(`Address localhost:${PORT} in use. Please retry when the port is available!`);
    server.close();
  } else {
    console.error('Server error:', error);
  }
});

setInterval(() => {}, 1000 * 60 * 10);

let file = require.resolve(__filename);
fs.watchFile(file, () => {
  fs.unwatchFile(file);
  console.log(chalk.redBright(`Update ${__filename}`));
  delete require.cache[file];
  require(file);
});