import fs from 'node:fs';
import path from 'node:path';
import readline from 'node:readline';
import {pathToFileURL} from 'node:url';
import {start} from './runtime.mjs';
import {seed} from './fixture.mjs';
const runtime=await start();
let seeded=false;
console.log('Synthetic Firebase ready',runtime.url);
let failed=false;
const stream=readline.createInterface({input:process.stdin});
try {
 for await(const command of stream) {
   if(command==='stop')break;
   try {
     if(command==='build')await runtime.build();
     if(['run','managed'].includes(command)&&!seeded){await seed(runtime);seeded=true;}
     if(['run','managed'].includes(command))await (await import(pathToFileURL(path.join(import.meta.dirname,'scenario.mjs')).href+'?run='+Date.now())).run(runtime,command==='managed'?'managed':'browser');
     console.log('Completed',command);
   }catch(error){failed=true;console.error(error.stack);}
 }
}finally{await runtime.close();stream.close();process.stdin.destroy();}
process.exit(failed?1:0);
