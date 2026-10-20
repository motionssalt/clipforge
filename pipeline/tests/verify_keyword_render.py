"""Full Stage B integration on existing real episode footage; never publishes to Zernio."""
from pathlib import Path
import json
import subprocess
from PIL import Image
from pipeline.stage_b.run import run_stage_b

root = Path('keyword-proof')
root.mkdir(exist_ok=True)
subprocess.run(['gh','release','download','clipforge-hxh6-p9','--repo','motionssalt/clipforge','--pattern','final.mp4','--dir',str(root),'--clobber'],check=True)
duration = float(subprocess.check_output(['ffprobe','-v','error','-show_entries','format=duration','-of','csv=p=0',str(root/'final.mp4')]).decode().strip())
plan = {'video_duration_seconds': int(duration), 'target_total_duration_seconds':8, 'title':'Keyword color verification', 'cuts':[{'start_seconds':0,'end_seconds':8,'voiceover_text':'a victory, at last. His challenge is complete. Victory means something different now.', 'keywords':[{'word':'VICTORY','color':'#FF3030'},{'word':'challenge','color':'#30FF50'}]}]}
p = root/'production.json'
p.write_text(json.dumps(plan,indent=2))
result = run_stage_b(job_id='keyword-color-proof', production_json=p, original_video=root/'final.mp4',work_dir=root/'render',enhance_enabled=True,enable_face_detection=False,write_status=False,whisper_model='tiny')
final = root/'render/out/final.mp4'
# Locate final output rather than assuming intermediate names.
print(json.dumps(result,default=str,indent=2))
final = Path(result.get('final_mp4') or result.get('final_video') or final)
if not final.is_file():
 final = next((root/'render/out').glob('*delivery*.mp4'), final)
assert final.is_file(), f'final video not found: {final}'
subprocess.run(['ffmpeg','-y','-i',str(final),'-vf','fps=2','-frames:v','30',str(root/'proof_%03d.png')],check=True)
red = green = 0
for path in root.glob('proof_*.png'):
 image=Image.open(path).convert('RGB')
 w,h=image.size
 for r,g,b in image.crop((0,int(h*.42),w,int(h*.72))).getdata():
  red += r>180 and g<90 and b<100
  green += g>180 and r<100 and b<120
assert red>100 and green>100, (red,green)
print(f'PASS: full Stage B final video has red victory and green challenge pixels: red={red}, green={green}')
