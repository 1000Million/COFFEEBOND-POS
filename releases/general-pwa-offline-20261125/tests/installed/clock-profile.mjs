import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import {createHash} from 'node:crypto';
import {spawn,execFileSync} from 'node:child_process';
import {setTimeout as delay} from 'node:timers/promises';
import {fileURLToPath} from 'node:url';
const root=fileURLToPath(new URL('../../',import.meta.url));
export async function prepareClockProfile(profile, appOrigin, functionsOrigin) {
  assert.equal(process.platform,'darwin');
  for(const url of [appOrigin,functionsOrigin]) {
    const u=new URL(url);assert.equal(u.protocol,'http:');assert.equal(u.hostname,'127.0.0.1');assert(u.port);
  }
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'cb-cw-')),extensionDir=path.join(dir,'extension');
  fs.cpSync(path.join(root,'continuity/extension'),extensionDir,{recursive:true});
  const manifestPath=path.join(extensionDir,'manifest.json');
  const manifest=JSON.parse(fs.readFileSync(manifestPath));
  const extensionId=[...createHash('sha256').update(Buffer.from(manifest.key,'base64')).digest('hex').slice(0,32)]
    .map(v=>String.fromCharCode(97+parseInt(v,16))).join('');
  manifest.host_permissions=['http://127.0.0.1/*'];
  manifest.externally_connectable.matches=['http://127.0.0.1/*'];
  fs.writeFileSync(manifestPath,JSON.stringify(manifest));
  fs.writeFileSync(path.join(extensionDir,'config.js'),'export const origin='+JSON.stringify(new URL(appOrigin).origin)+';\nexport const callable='+JSON.stringify(new URL('/demo-coffee-bond-offline/us-central1/offlineCash',functionsOrigin).href)+';\n');
  const exe=path.join(dir,'clock'),socketDir=path.join(dir,'run');
  execFileSync('/usr/bin/clang',['-fobjc-arc','-DCOFFEE_BOND_CLOCK_QUALIFICATION=1','-Werror','-Wall','-Wno-incompatible-pointer-types','-framework','Foundation','-framework','AppKit','-framework','Security','-framework','CoreGraphics',path.join(root,'continuity/macos/clock.m'),'-o',exe]);
  execFileSync('/usr/bin/codesign',['--force','--sign','-',exe]);
  const wrapper=path.join(dir,'native-host');
  fs.writeFileSync(wrapper,'#!/bin/sh\nexport COFFEE_BOND_CLOCK_DIR='+socketDir+'\nexec '+exe+' "$@"\n',{mode:0o700});
  const manifests=path.join(profile,'NativeMessagingHosts');fs.mkdirSync(manifests,{recursive:true});
  fs.writeFileSync(path.join(manifests,'in.coffeebond.session_clock.json'),JSON.stringify({name:'in.coffeebond.session_clock',description:'Synthetic POS clock',path:wrapper,type:'stdio',allowed_origins:['chrome-extension://'+extensionId+'/']}));
  let service;
  const start = async()=>{
    service=spawn(exe,['--serve'],{env:{...process.env,COFFEE_BOND_CLOCK_DIR:socketDir},stdio:'ignore'});
    for(let i=0;i<100;i++){if(fs.existsSync(path.join(socketDir,'broker.sock')))return;assert.equal(service.exitCode,null);await delay(30);}
    throw Error('Local test clock did not start.');
  };
  const stop=async()=>{if(service && service.exitCode===null && !service.signalCode){const exit=new Promise(resolve=>service.once('exit',resolve));service.kill();await exit;}};
  await start();
  return {extensionDir,extensionId,stop,start,close:async()=>{await stop();fs.rmSync(dir,{recursive:true,force:true});}};
}
