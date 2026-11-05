import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { describe, it, expect } from 'vitest';
import { join } from 'node:path';
const exec = promisify(execFile);
it('uses scene groups and per-clip User1 LUT with readback while preserving existing grades', async () => {
  const script = `
import importlib.util, json, sys
spec=importlib.util.spec_from_file_location('host',sys.argv[1]); h=importlib.util.module_from_spec(spec);spec.loader.exec_module(h)
h.clip_like_has_canonical_repair_layout=lambda item: True
class Graph:
 def __init__(self,lut=''): self.lut=lut;self.writes=[]
 def GetLUT(self,index): return self.lut if index==3 else ''
 def SetLUT(self,index,lut): self.writes.append(index);self.lut=lut;return True
class Item:
 def __init__(self,lut=''):self.graph=Graph(lut)
 def GetNodeGraph(self):return self.graph
request={'rawRelativePath':'C001.MP4','sceneCategory':'portrait','effectiveProfile':'slog3','resolvedLutRelativePath':'Sony/Log.cube','resolvedLutAbsolutePath':'/LUT/Sony/Log.cube'}
item=Item(); applied=h.apply_scene_clip_transform(item,request,False)
reused=h.apply_scene_clip_transform(item,request,True)
other=Item('manual.cube')
try: h.apply_scene_clip_transform(other,request,True);blocked=False
except h.HostError: blocked=True
rec709=h.apply_scene_clip_transform(Item(),{'rawRelativePath':'C002.MP4','sceneCategory':'portrait','effectiveProfile':'rec709'},False)
print(json.dumps({'group':h.build_clip_creative_summary(request),'applied':applied,'reused':reused,'indices':item.graph.writes,'blocked':blocked,'preserved':other.graph.lut,'rec709':rec709},ensure_ascii=False))
`;
  const { stdout } = await exec('python3', ['-c', script, join(process.cwd(), 'vendor/resolve-color-host/resolve-color-host.py')]);
  expect(JSON.parse(stdout)).toEqual({ group: { creativeTags: ['portrait'], displayName: '竖屏' }, applied: 'applied-user1', reused: 'already-applied', indices: [3], blocked: true, preserved: 'manual.cube', rec709: 'rec709-bypass' });
});
