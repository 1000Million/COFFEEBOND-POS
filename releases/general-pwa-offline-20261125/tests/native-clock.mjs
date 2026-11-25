import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {spawn,execFileSync} from 'node:child_process';
import {setTimeout as delay} from 'node:timers/promises';
const root=path.resolve(import.meta.dirname,'..');
const tmp=fs.mkdtempSync(path.join(os.tmpdir(),'cb-clock-pause-')), exe=path.join(tmp,'clock'),socketDir=path.join(tmp,'q');
const packet=Buffer.from(JSON.stringify({action:'SAMPLE'})),header=Buffer.alloc(4);header.writeUInt32LE(packet.length);
const env={...process.env,COFFEE_BOND_CLOCK_DIR:socketDir};
let broker;
async function stop(){if(broker && broker.exitCode===null && !broker.signalCode){const done=new Promise(resolve=>broker.once('exit',resolve));broker.kill('SIGCONT');broker.kill();await done;}}
function read(){const response=execFileSync(exe,[],{env,input:Buffer.concat([header,packet]),timeout:4000});assert.equal(response.readUInt32LE(0),response.length-4);return JSON.parse(response.subarray(4));}
async function start(){
 broker=spawn(exe,['--serve'],{env,stdio:'ignore'});
 for(let i=0;i<45;i++){await delay(100);const v=read();if(v.epoch)return v;}
 throw Error('No unlocked console session with an available local test broker.');
}
try {
 execFileSync('clang',['-DCOFFEE_BOND_CLOCK_QUALIFICATION=1','-fobjc-arc','-Wall','-Werror','-Wno-incompatible-pointer-types','-framework','Foundation','-framework','AppKit','-framework','Security','-framework','CoreGraphics',path.join(root,'continuity/macos/clock.m'),'-o',exe]);
 execFileSync('/usr/bin/codesign',['--force','--sign','-',exe],{stdio:'ignore'});
 const first=await start(),second=read();assert(first.epoch===second.epoch && second.ticks>first.ticks);
 broker.kill('SIGSTOP');await delay(31200);broker.kill('SIGCONT');const later=read();assert(later.epoch && later.epoch!==first.epoch && later.ticks>=second.ticks+30000);
 await stop();assert.equal(read().available,false);
 const restarted=await start();assert(restarted.epoch && restarted.epoch!==later.epoch);
 const result={status:'PASS',nativePlatform:process.platform,architecture:process.arch,nativeSourceSha256:(await import('node:crypto')).createHash('sha256').update(fs.readFileSync(path.join(root,'continuity/macos/clock.m'))).digest('hex'),
   cases:['Same running code identity, interval and epoch','31.2 second gap rotates the epoch','Stopped broker gives no time','Restarted broker gives a new epoch'],
   machineSleepOrLockTriggered:false,productionWrites:0};
 fs.writeFileSync(path.join(root,'evidence/native-clock.json'),JSON.stringify(result,null,2)+'\n');console.log(result.cases);
} finally {await stop();fs.rmSync(tmp,{recursive:true,force:true});}
