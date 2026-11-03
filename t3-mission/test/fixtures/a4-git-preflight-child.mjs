import fs from 'node:fs';
import path from 'node:path';
import {createHandlerHud} from '../hud-handler-fixture.mjs';
const dir=process.argv[2];
const hud=await createHandlerHud({missionDir:dir,gitPreflightTimeoutMs:Number(process.argv[3]),runtimeAdapter:{resumeWorker:async()=>({resumed:true})}});
setTimeout(()=>fs.writeFileSync(path.join(dir,'event-loop-timer'),'ran'),20);
try{const response=await hud.post('resume');fs.writeFileSync(path.join(dir,'handler-response.json'),JSON.stringify(response));}finally{await hud.close();}
