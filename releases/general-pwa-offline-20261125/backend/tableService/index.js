'use strict';
const admin=require('firebase-admin');const{onCall}=require('firebase-functions/v2/https');admin.initializeApp();const{createTableService}=require('./tableService');exports.tableService=onCall({region:'us-central1'},createTableService({db:admin.firestore(),admin}).run);
// Local built-counter regression boundary only. No additional production export.
if(process.env.FUNCTIONS_EMULATOR==='true'&&process.env.GCLOUD_PROJECT==='demo-coffee-bond-tables')exports.authorizePosAddOns=require('./posAddOnAuthorization').createPosAddOnAuthorizationFunction({admin,db:admin.firestore(),region:'us-central1'});
