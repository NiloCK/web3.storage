import debug from 'debug'
import settle from 'p-settle'

import {
  UPLOAD_TYPES,
  PIN_STATUSES
} from '../../../api/src/constants.js'

import { MAX_CONCURRENT_QUERIES } from '../lib/utils.js'
const log = debug('metrics:updateMetrics')

/**
 * @typedef {import('pg').Pool} Client
 * @typedef {{ name: string, value: number }} Metric
 */

const COUNT_USERS = 'SELECT COUNT(*) AS total FROM public.user'

const SUM_CONTENT_DAG_SIZE = 'SELECT SUM(c.dag_size) AS "total" FROM content c'

const COUNT_UPLOADS = 'SELECT COUNT(*) AS total FROM upload'

const COUNT_UPLOADS_PER_TYPE = 'SELECT COUNT(*) AS total FROM upload WHERE type = $1'

const COUNT_PINS =
  'SELECT COUNT(*) AS total FROM pin'

const COUNT_PINS_PER_STATUS =
  'SELECT COUNT(*) AS total FROM pin WHERE status = $1'

const COUNT_PIN_REQUESTS = 'SELECT COUNT(*) AS total FROM psa_pin_request'

const UPDATE_METRIC = `
INSERT INTO metric (name, value, updated_at)
     VALUES ($1, $2, TIMEZONE('utc', NOW()))
ON CONFLICT (name) DO UPDATE
        SET value = $2, updated_at = TIMEZONE('utc', NOW())
`

/**
 * Calculate metrics from RO DB and update their current values in the RW DB.
 *
 * @param {{ rwPg: Client, roPg: Client }} config
 */
export async function updateMetrics ({ roPg, rwPg }) {
  const results = await settle([
    withTimeLog('updateUsersCount', () => updateUsersCount(roPg, rwPg)),
    withTimeLog('updateContentRootDagSizeSum', () =>
      updateContentRootDagSizeSum(roPg, rwPg)
    ),
    withTimeLog('updateUploadsCount', () => updateUploadsCount(roPg, rwPg)),
    ...UPLOAD_TYPES.map((t) =>
      withTimeLog(`updateUploadsCount[${t}]`, () =>
        updateUploadsCount(roPg, rwPg, { type: t })
      )
    ),
    withTimeLog('updatePinsCount', () => updatePinsCount(roPg, rwPg)),
    ...PIN_STATUSES.map((s) =>
      withTimeLog(`updatePinsCount[${s}]`, () =>
        updatePinsCount(roPg, rwPg, { status: s })
      )
    ),
    withTimeLog('updatePinRequestsCount', () => updatePinRequestsCount(roPg, rwPg)),
    { concurrency: MAX_CONCURRENT_QUERIES }
  ])

  let error
  for (const promise of results) {
    if (promise.isFulfilled) continue
    error = error || promise.reason
    console.error(promise.reason)
  }

  if (error) throw error
  log('✅ Done')
}

/**
 * @param {Client} roPg
 * @param {Client} rwPg
 */
async function updateUsersCount (roPg, rwPg) {
  const { rows } = await roPg.query(COUNT_USERS)
  if (!rows.length) throw new Error('no rows returned counting users')
  await rwPg.query(UPDATE_METRIC, ['users_total', rows[0].total])
}

/**
 * @param {Client} roPg
 * @param {Client} rwPg
 */
async function updateContentRootDagSizeSum (roPg, rwPg) {
  const { rows } = await roPg.query(SUM_CONTENT_DAG_SIZE)
  if (!rows.length) throw new Error('no rows returned counting users')
  await rwPg.query(UPDATE_METRIC, ['content_bytes_total', String(rows[0].total)])
}

/**
 * @param {Client} roPg
 * @param {Client} rwPg
 * @param {Object} [options]
 * @param {string} [options.type]
 */
async function updateUploadsCount (roPg, rwPg, { type } = {}) {
  if (type) {
    const { rows } = await roPg.query(COUNT_UPLOADS_PER_TYPE, [type])
    if (!rows.length) throw new Error(`no rows returned counting ${type} uploads`)
    return rwPg.query(UPDATE_METRIC, [
      `uploads_${type.toLowerCase()}_total`,
      rows[0].total
    ])
  }

  const { rows } = await roPg.query(COUNT_UPLOADS)
  if (!rows.length) throw new Error('no rows returned counting uploads')
  return rwPg.query(UPDATE_METRIC, [
    'uploads_total',
    rows[0].total
  ])
}

/**
 * @param {Client} roPg
 * @param {Client} rwPg
 * @param {Object} [options]
 * @param {string} [options.status]
 */
async function updatePinsCount (roPg, rwPg, { status } = {}) {
  if (status) {
    const { rows } = await roPg.query(COUNT_PINS_PER_STATUS, [status])
    if (!rows.length) {
      throw new Error(`no rows returned counting ${status} pins`)
    }
    await rwPg.query(UPDATE_METRIC, [
      `pins_${status.toLowerCase()}_total`,
      rows[0].total
    ])
  }

  const { rows } = await roPg.query(COUNT_PINS)
  if (!rows.length) {
    throw new Error('no rows returned counting pins')
  }
  await rwPg.query(UPDATE_METRIC, [
    'pins_total',
    rows[0].total
  ])
}

/**
 * @param {Client} roPg
 * @param {Client} rwPg
 */
async function updatePinRequestsCount (roPg, rwPg) {
  const { rows } = await roPg.query(COUNT_PIN_REQUESTS)
  if (!rows.length) throw new Error('no rows returned counting pin requests')
  await rwPg.query(UPDATE_METRIC, ['pin_requests_total', rows[0].total])
}

/**
 * @template T
 * @param {string} name
 * @param {() => Promise<T>} fn
 * @returns {Promise<T>}
 */
async function withTimeLog (name, fn) {
  const start = Date.now()
  try {
    return await fn()
  } finally {
    log(`${name} took: ${Date.now() - start}ms`)
  }
}
