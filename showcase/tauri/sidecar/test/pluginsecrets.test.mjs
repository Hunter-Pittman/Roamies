import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createSecrets } from '../secrets.mjs';
const dir=await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(),'roamies-plugin-secrets-')));
const exec=async(_cmd,args,input)=>{await new Promise(r=>setTimeout(r,2));return {code:0,stdout:args.at(-1).includes('::Protect(')?Buffer.from(input).toString('base64'):Buffer.from(input,'base64').toString()};};
try{
 const a=createSecrets({platform:'win32',dataDir:dir,exec}),b=createSecrets({platform:'win32',dataDir:dir,exec});
 await Promise.all(Array.from({length:20},(_,i)=>(i%2?a:b).set(`key-${i}`,`value-${i}`)));
 for(let i=0;i<20;i++)assert.equal(await a.get(`key-${i}`),`value-${i}`,'concurrent instances do not lose updates');
 await Promise.all([a.delete('key-0'),b.set('existing','preserved')]);assert.equal(await b.get('existing'),'preserved');assert.equal(await a.get('key-0'),null);
 await fs.writeFile(path.join(dir,'secrets.json'),'{invalid');await assert.rejects(a.set('new','value'),/JSON|property|position|Expected/i);assert.equal(await fs.readFile(path.join(dir,'secrets.json'),'utf8'),'{invalid','corrupt store fails closed without overwriting existing credentials');
 console.log('Shared secret-store serialization and fail-closed corruption tests: passed');
}finally{await fs.rm(dir,{recursive:true,force:true});}
