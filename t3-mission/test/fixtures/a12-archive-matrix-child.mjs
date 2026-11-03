import {archiveObservation} from '../../kernel/autopilot-store.mjs';
import * as k from '../../kernel/index.mjs';
const [dir,raw,phase] = process.argv.slice(2);
if (phase === 'before_archive') process.exit(77);
archiveObservation(dir, JSON.parse(raw));
if (phase === 'after_reduce') await k.missionTick(dir, {now: 1793000001001});
process.exit(77);
