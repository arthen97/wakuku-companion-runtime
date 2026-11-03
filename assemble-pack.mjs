// Reconstruct only the frozen content-addressed Godot pack; no network access.
import {createHash} from 'node:crypto';
import {createReadStream,createWriteStream} from 'node:fs';
import {readFile,rename,rm} from 'node:fs/promises';
import {once} from 'node:events';
import {finished} from 'node:stream/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';

const root=path.dirname(fileURLToPath(import.meta.url));
const expected='770d4b65cb8bac364ca3f51fdb0a49ffc2293676ea53acbdb129ca21889f1d0e';
const manifest=JSON.parse(await readFile(path.join(root,'pack-parts/manifest.json'),'utf8'));
if(manifest.pack!=='companion-770d4b65cb8b.pck'||manifest.pack_sha256!==expected||manifest.pack_bytes!==108173784||manifest.parts.length!==3)throw Error('Unexpected frozen pack manifest');
const destination=path.join(root,'dist',manifest.pack),temporary=destination+'.assembling';
const output=createWriteStream(temporary);
const outputFinished=finished(output);
outputFinished.catch(()=>{});
const whole=createHash('sha256');let total=0;
try {
 for(const [index,part] of manifest.parts.entries()) {
  if(part.file!==manifest.pack+'.part'+String(index+1).padStart(2,'0')||part.bytes>48*1024*1024)throw Error('Unexpected pack part');
  const digest=createHash('sha256');let bytes=0;
  for await(const chunk of createReadStream(path.join(root,'pack-parts',part.file))) {
   digest.update(chunk);whole.update(chunk);bytes+=chunk.length;total+=chunk.length;
   if(!output.write(chunk))await once(output,'drain');
  }
  if(bytes!==part.bytes||digest.digest('hex')!==part.sha256)throw Error('Pack part verification failed: '+part.file);
 }
 output.end();await outputFinished;
 const actual=whole.digest('hex');
 if(total!==108173784||actual!==expected)throw Error('Frozen pack SHA-256 verification failed');
 await rename(temporary,destination);
 console.info('wakuku_pack_assembled',JSON.stringify({pack:manifest.pack,bytes:total,sha256:actual}));
} catch(error) {
 output.destroy();await outputFinished.catch(()=>{});await rm(temporary,{force:true});throw error;
}
