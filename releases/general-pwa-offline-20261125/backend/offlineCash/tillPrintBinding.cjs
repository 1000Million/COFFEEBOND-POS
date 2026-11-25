'use strict';
const STORE = 'L0qB13uuPxHvv089YtGQ';
const id = value => typeof value === 'string' && /^[a-zA-Z0-9_-]{8,100}$/.test(value);
const version = value => Number.isSafeInteger(value) && value > 0;
function validRoute(route) {
  return typeof route?.queue === 'string' && route.queue.trim() === route.queue && route.queue.length > 0 && route.queue.length <= 240
    && !/[\x00-\x1f]/.test(route.queue) && version(route.queueVersion) && version(route.generation);
}
function pickRoute(route) {
  return {queue:route.queue, queueVersion:route.queueVersion, generation:route.generation};
}
async function resolvePrintBinding(get, storeId, deviceId) {
  if (storeId !== STORE || !id(deviceId)) return null;
  const policy = await get('offlinePilotPolicies/sector51');
  const config = policy?.localPrint;
  if (policy?.enabled !== true || policy.storeId !== storeId || policy.approvedDevice?.deviceId !== deviceId
      || config?.enabled !== true || !id(config.stationId) || !validRoute(config.receipt) || config.receipt.witnessed !== true) return null;
  const station = await get('printStations/'+config.stationId);
  if (!station || station.id !== config.stationId || station.storeId !== storeId || station.active !== true || station.revokedAt
      || station.protocolVersion !== 2 || typeof station.publicKey !== 'string'
      || !station.queues?.some(q => q.name === config.receipt.queue)) return null;
  const routes = {RECEIPT:pickRoute(config.receipt)};
  for (const department of ['KITCHEN','BARISTA']) {
    const route = await get('printAssignments/'+storeId+'_'+department);
    if (!validRoute(route) || route.stationId !== station.id || route.storeId !== storeId || route.department !== department
        || route.generation !== station.assignmentGenerations?.[department] || route.enabled !== true || route.witnessed !== true
        || !station.queues.some(q => q.name === route.queue)) return null;
    routes[department] = pickRoute(route);
  }
  return {printStationId:station.id, printStationPublicKey:station.publicKey, printRoutes:routes};
}
async function readTillPrintBinding(tx, db, storeId, deviceId) {
  return resolvePrintBinding(async path => (await tx.get(db.doc(path))).data(), storeId, deviceId);
}
module.exports = {STORE, validRoute, resolvePrintBinding, readTillPrintBinding};
