const sqlite3 = require('sqlite3')
const path = require('path')
const url = require('url')
const { cbPromise } = require('../lib/functions')
const { setupSqliteDB } = require('../lib/db')
const datDns = require('../dat/dns')
const datLibrary = require('../dat/library')

// globals
// =

var db
var migrations
var setupPromise

// exported methods
// =

/**
 * @param {Object} opts
 * @param {string} opts.userDataPath
 */
exports.setup = function (opts) {
  // open database
  var dbPath = path.join(opts.userDataPath, 'SiteData')
  db = new sqlite3.Database(dbPath)
  setupPromise = setupSqliteDB(db, {migrations}, '[SITEDATA]')
}

/**
 * @param {string} url
 * @param {string} key
 * @param {number | string} value
 * @param {Object} [opts]
 * @param {boolean} [opts.dontExtractOrigin]
 * @returns {Promise<void>}
 */
const set = exports.set = async function (url, key, value, opts) {
  await setupPromise
  var origin = opts && opts.dontExtractOrigin ? url : await extractOrigin(url)
  if (!origin) return null
  return cbPromise(cb => {
    db.run(`
      INSERT OR REPLACE
        INTO sitedata (origin, key, value)
        VALUES (?, ?, ?)
    `, [origin, key, value], cb)
  })
}

/**
 * @param {string} url
 * @param {string} key
 * @returns {Promise<void>}
 */
const clear = exports.clear = async function (url, key) {
  await setupPromise
  var origin = await extractOrigin(url)
  if (!origin) return null
  return cbPromise(cb => {
    db.run(`
      DELETE FROM sitedata WHERE origin = ? AND key = ?
    `, [origin, key], cb)
  })
}

/**
 * @param {string} url
 * @param {string} key
 * @param {Object} [opts]
 * @param {boolean} [opts.dontExtractOrigin]
 * @returns {Promise<string>}
 */
const get = exports.get = async function (url, key, opts) {
  await setupPromise
  var origin = opts && opts.dontExtractOrigin ? url : await extractOrigin(url)
  if (!origin) return null
  return cbPromise(cb => {
    db.get(`SELECT value FROM sitedata WHERE origin = ? AND key = ?`, [origin, key], (err, res) => {
      if (err) return cb(err)
      cb(null, res && res.value)
    })
  })
}

/**
 * @param {string} url
 * @returns {Promise<Object>}
 */
const getPermissions = exports.getPermissions = async function (url) {
  await setupPromise
  var origin = await extractOrigin(url)
  if (!origin) return null
  return cbPromise(cb => {
    db.all(`SELECT key, value FROM sitedata WHERE origin = ? AND key LIKE 'perm:%'`, [origin], (err, rows) => {
      if (err) return cb(err)

      // convert to a dictionary
      // TODO - pull defaults from browser settings
      var perms = { /* js: true */ }
      if (rows) rows.forEach(row => { perms[row.key.slice('5')] = row.value })
      cb(null, perms)
    })
  })
}

/**
 * @param {string} url
 * @returns {Promise<Array<string>>}
 */
exports.getNetworkPermissions = async function (url) {
  await setupPromise
  var origin = await extractOrigin(url)
  if (!origin) return null
  return cbPromise(cb => {
    db.all(`SELECT key, value FROM sitedata WHERE origin = ? AND key LIKE 'perm:network:%'`, [origin], (err, rows) => {
      if (err) return cb(err)

      // convert to array
      var origins = /** @type string[] */([])
      if (rows) {
        rows.forEach(row => {
          if (row.value) origins.push(row.key.split(':').pop())
        })
      }
      cb(null, origins)
    })
  })
}

/**
 * @param {string} url
 * @returns {Promise<Object>}
 */
const getAppPermissions = exports.getAppPermissions = async function (url) {
  await setupPromise
  var origin = await extractOrigin(url)
  if (!origin) return null
  return cbPromise(cb => {
    db.all(`SELECT key, value FROM sitedata WHERE origin = ? AND key LIKE 'perm:app:%'`, [origin], (err, rows) => {
      if (err) return cb(err)

      // convert to app perms object
      var appPerms = {}
      if (rows) {
        rows.forEach(row => {
          let [api, perm] = row.key.split(':').slice(2)
          if (!appPerms[api]) appPerms[api] = []
          appPerms[api].push(perm)
        })
      }
      cb(null, appPerms)
    })
  })
}

/**
 * @param {string} url
 * @param {string} key
 * @returns {Promise<string>}
 */
const getPermission = exports.getPermission = function (url, key) {
  return get(url, 'perm:' + key)
}

/**
 * @param {string} url
 * @param {string} key
 * @param {string | number} value
 * @returns {Promise<void>}
 */
const setPermission = exports.setPermission = function (url, key, value) {
  value = value ? 1 : 0
  return set(url, 'perm:' + key, value)
}

/**
 * @param {string} url
 * @param {Object} appPerms
 * @returns {Promise<void>}
 */
const setAppPermissions = exports.setAppPermissions = async function (url, appPerms) {
  await setupPromise
  var origin = await extractOrigin(url)
  if (!origin) return null
  appPerms = appPerms || {}

  // clear all existing app perms
  await cbPromise(cb => {
    db.run(`
      DELETE FROM sitedata WHERE origin = ? AND key LIKE 'perm:app:%'
    `, [origin], cb)
  })

  // set perms given
  for (let api in appPerms) {
    if (!Array.isArray(appPerms[api])) {
      continue
    }
    for (let perm of appPerms[api]) {
      await set(url, `perm:app:${api}:${perm}`, 1)
    }
  }
}

/**
 * @param {string} url
 * @param {string} key
 * @returns {Promise<void>}
 */
const clearPermission = exports.clearPermission = function (url, key) {
  return clear(url, 'perm:' + key)
}

/**
 * @param {string} key
 * @returns {Promise<void>}
 */
const clearPermissionAllOrigins = exports.clearPermissionAllOrigins = async function (key) {
  await setupPromise
  key = 'perm:' + key
  return cbPromise(cb => {
    db.run(`
      DELETE FROM sitedata WHERE key = ?
    `, [key], cb)
  })
}

exports.WEBAPI = {
  get,
  set,
  getPermissions,
  getPermission,
  getAppPermissions,
  setPermission,
  setAppPermissions,
  clearPermission,
  clearPermissionAllOrigins
}

// internal methods
// =

/**
 * @param {string} originURL
 * @returns {Promise<string>}
 */
async function extractOrigin (originURL) {
  var urlp = url.parse(originURL)
  if (!urlp || !urlp.host || !urlp.protocol) return
  if (urlp.protocol === 'dat:') {
    urlp.host = await datDns.resolveName(urlp.host)
  }
  return (urlp.protocol + urlp.host)
}

migrations = [
  // version 1
  // - includes favicons for default bookmarks
  function (cb) {
    db.exec(`
      CREATE TABLE sitedata(
        origin NOT NULL,
        key NOT NULL,
        value
      );
      CREATE UNIQUE INDEX sitedata_origin_key ON sitedata (origin, key);
      INSERT OR REPLACE INTO "sitedata" VALUES('https:duckduckgo.com','favicon','data:image/png;base64,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');
      --- beakerbrowser.com
      INSERT OR REPLACE INTO "sitedata" VALUES('dat:87ed2e3b160f261a032af03921a3bd09227d0a4cde73466c17114816cae43336','favicon','data:image/png;base64,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');
      PRAGMA user_version = 1;
    `, cb)
  },
  // version 2
  // - more favicons for default bookmarks (removed)
  function (cb) {
    db.exec(`
      PRAGMA user_version = 2;
    `, cb)
  },
  // version 3
  // - more favicons for default bookmarks
  function (cb) {
    db.exec(`
      INSERT OR REPLACE INTO "sitedata" VALUES('https:hashbase.io','favicon','data:image/png;base64,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');
      INSERT OR REPLACE INTO "sitedata" VALUES('https:twitter.com','favicon','data:image/png;base64,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');
      INSERT OR REPLACE INTO "sitedata" VALUES('https:github.com','favicon','data:image/png;base64,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');
      PRAGMA user_version = 3;
    `, cb)
  },
  // version 4
  // - more favicons for default bookmarks (removed)
  function (cb) {
    db.exec(`
      PRAGMA user_version = 4;
    `, cb)
  },
  // version 5
  // - more favicons for default bookmarks
  function (cb) {
    db.exec(`
      INSERT OR REPLACE INTO "sitedata" VALUES('https:opencollective.com','favicon','data:image/png;base64,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');
      --- datprotocol.org
      INSERT OR REPLACE INTO "sitedata" VALUES('dat:6ff62299bf38ee578c18cf698957b7b162a35a9aceb157345c79dbde26eba524','favicon','data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAACAAAAAgCAYAAABzenr0AAADVklEQVRYR+2XX0hTcRTHz293925u022ZgSVFMv+AmZgvERn98UF9CSqwjFqmRsicaARRiWDsKQqbuCIqsbR6MaFADSpKoh4SNDAWoqIhJYjT9u/u7t7dG7/pzM25XZcPPew+jt/vnM/vfM8434Mgxs9G27Y3D5t7WJ4lTAWXj2nkmolYQqH1XhIEgXg+8eqm+Vt7PcdzAAiAQARczDx9T591og4h5F1PzHUBfJr5cv7GUGvrL8+sIlGqAJIgAQQAVmDBwbphiyyZuZpvaDiYutciFkIUwKR9cp9p2NIxODeikxEUKAg5CDjzig8BAtrnAdrHwG5t9lRjnlGfod35IRpIRACXy5VqHn30sPvH6xJca/xqnCg0eSAJDoaxnBwNvMDD0bTD72tzKs5pE7RTa4GEBcA6Px3vud1m7TTSnAeSSKVf57UShwbHkBjAzrmAkkjhQtap+xWZZUaEELP6bMgvK3VWSRVAESQIQnC5o5X1b0UQsAIHDtYFm2Uapim/rqEwpD+WK7Css21EJ5OE11ls4lWvRAhojgGPj4FcbdZUY4FRn5G42B/LAEW95Qt2zqlWEgkRdY4ZYql3XBwNiaTy99vSZ5oggOL+Mw6vj1WJ1flfQCgJ6ewveZIYBFDSf9bh8TGqWAOv556ckDn7ih/HAeIViFcgXoF4Bf6zCiwOI68qtskvfhJgsyIjSGdfccgwOtJbvuDkXGrs9wLWSnzY6CcXYyJw+2hQSRWrx/G4fWq/acjcMTz/PV0mISEhjPGMnib8CfxqbEY8vBdy1Lrpa/m1+myN7l3QOA5cHfj5udr01WKeZebkSmy9kVS0FwznDbElc3JuSKbUzJW8mktF2wrbgt10GGhBEKjOse5bd61dBob3gkqKTalENIjflALv94KUhITKzJMPKrPKDKJM6UqeOfdcmsXa2f5y+k0Rdm8qaXS7hrX223IQoHTrgYGG3OqKSGubqMUk0B9DNmu6nKDC9sfiYoJ1ZmBXkm66aY9Rr1vSOVLviAIIBPg4M1jVPNTSOsvY5CpCAaRE6re1LM+Bk3XDJpmavZ5XU38oROcNA8CB8NLSOdbdYrF2GTiB88fGS0tVBJ03FCAQbJ6e39E8fOcFy3NUU0Hd8RR5ymgsf9M/ZY+2MKvt5z0AAAAASUVORK5CYII=');
      --- taravancil.com
      INSERT OR REPLACE INTO "sitedata" VALUES('dat:4fa30df06cbeda4ae87be8fd4334a61289be6648fb0bf7f44f6b91d2385c9328','favicon','data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAABAAAAAQCAYAAAAf8/9hAAAAHklEQVQ4T2MsOrXzPwMFgHHUAIbRMGAYDQOGYREGAKNTL1G9PdjfAAAAAElFTkSuQmCC');
      PRAGMA user_version = 5;
    `, cb)
  }
]
