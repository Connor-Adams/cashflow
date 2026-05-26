'use strict'

// Diagnostic wrapper around pino-opentelemetry-transport. Surfaces worker-side
// errors that the underlying transport swallows via abstract-transport's
// `res.catch(err => stream.destroy(err))`.
//
// process._rawDebug writes directly to fd 2, bypassing all stream wrapping
// and worker IPC. Output appears in Railway log capture verbatim.
//
// Remove this wrapper (and the matching target swap in logger.ts) once we've
// identified the root cause of the silent worker exit.

const rawDbg = (msg) => {
  try {
    process._rawDebug(`[otlp-wrapper] ${msg}`)
  } catch {
    /* never throw from a diagnostic */
  }
}

module.exports = async function (opts) {
  rawDbg(`init opts=${JSON.stringify(opts).slice(0, 500)}`)

  let base
  try {
    base = require('pino-opentelemetry-transport')
  } catch (e) {
    rawDbg(`require failed: ${e && e.stack ? e.stack : e}`)
    throw e
  }

  let stream
  try {
    stream = await base(opts)
  } catch (e) {
    rawDbg(`base() rejected: ${e && e.stack ? e.stack : e}`)
    throw e
  }

  rawDbg(`base() resolved, stream type=${typeof stream}`)

  // Patch _destroy to log who destroys + with what error.
  const origDestroy = stream._destroy ? stream._destroy.bind(stream) : null
  if (origDestroy) {
    stream._destroy = function patchedDestroy (err, cb) {
      rawDbg(
        `_destroy invoked. err=${err && err.stack ? err.stack : err ? String(err) : 'null'}`,
      )
      return origDestroy(err, cb)
    }
  }

  // Listen for stream lifecycle events.
  for (const ev of ['error', 'end', 'finish', 'close']) {
    stream.on(ev, (...args) => {
      const arg0 = args[0]
      rawDbg(
        `event '${ev}' fired. arg0=${arg0 && arg0.stack ? arg0.stack : arg0 ? String(arg0) : ''}`,
      )
    })
  }

  // Surface unhandled rejections inside the worker.
  if (typeof process.on === 'function') {
    process.on('unhandledRejection', (reason) => {
      rawDbg(
        `unhandledRejection in worker: ${reason && reason.stack ? reason.stack : String(reason)}`,
      )
    })
    process.on('uncaughtException', (e) => {
      rawDbg(`uncaughtException in worker: ${e && e.stack ? e.stack : String(e)}`)
    })
    process.on('exit', (code) => {
      rawDbg(`worker process exit code=${code}`)
    })
  }

  return stream
}
