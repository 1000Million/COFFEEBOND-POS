'use strict';
// Local configuration binding for four new services only. Frozen handlers are unchanged.
const { setGlobalOptions } = require('firebase-functions/v2');
setGlobalOptions(require('./financial-runtime-options.json'));
const handlers = require('./index.js');
module.exports = {
  commitPosCheckout: handlers.commitPosCheckout,
  settlePosCheckout: handlers.settlePosCheckout,
  acceptPayAtCounterOrder: handlers.acceptPayAtCounterOrder,
  voidPosCheckout: handlers.voidPosCheckout,
};
