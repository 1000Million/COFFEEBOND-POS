'use strict';
const {setGlobalOptions}=require('firebase-functions/v2');
setGlobalOptions(require('./financial-runtime-options.json'));
const admin=require('firebase-admin');
admin.initializeApp();
exports.offlineCash=require('./offlineCash').createOfflineCashFunction({admin,db:admin.firestore(),region:'us-central1'});
