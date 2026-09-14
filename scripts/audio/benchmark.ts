import { transcodeTrackAudio } from '../../src/modules/media/transcode-track-audio';
import { stat } from 'node:fs/promises';
if (process.argv.length < 3) throw new Error('Supply source file paths to benchmark; outputs must not already exist.');
for (const input of process.argv.slice(2)) {
 const name=input.split('/').pop();
 const start=performance.now(); const result=await transcodeTrackAudio(input,input+'.delivery.mp3');
 console.log(JSON.stringify({name,seconds:(performance.now()-start)/1000,sourceBytes:(await stat(input)).size,...result,controllerMaxRss:process.resourceUsage().maxRSS}));
}
