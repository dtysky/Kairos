_G.KAIROS_VOICEOVER_TEST = true
local plugin = dofile('apps/resolve-volc-voiceover-plugin/KairosVolcVoiceover.lua')
local function eq(a,b) assert(a==b,tostring(a)..' ~= '..tostring(b)) end
local function scenario(options)
  options=options or {}
  local inserted, imported, copies, saves, deletes = 0,0,0,0,0
  local original, current, project, pool
  local clips={}
  local function folder(name)
    local f={name=name,children={},clips={}}
    function f:GetName() return self.name end
    function f:GetSubFolderList() return self.children end
    function f:GetClipList() return self.clips end
    return f
  end
  local root=folder('Root')
  local currentFolder=root
  local media={}
  function media:GetClipProperty(key)
    if key=='FPS' then return options.sourceFps or 30
    elseif key=='Duration' then return options.mediaDuration or '00:01:00:00'
    else return '/test/audio.mp3' end
  end
  local function item(id,name,startFrame,endFrame,sourceStart,sourceEnd)
    local i={id=id,name=name,startFrame=startFrame,endFrame=endFrame,sourceStart=sourceStart,sourceEnd=sourceEnd,markers={__flags=256}}
    function i:GetUniqueId() return self.id end
    function i:GetName() return self.name end
    function i:SetName(n) self.name=n; return true end
    function i:GetStart() return self.startFrame end
    function i:GetEnd() return self.endFrame end
    function i:GetDuration() return self.endFrame-self.startFrame end
    function i:GetSourceStartFrame() return self.sourceStart end
    function i:GetSourceEndFrame() return self.sourceEnd end
    function i:GetMediaPoolItem() return media end
    function i:AddMarker(frame,color,name,note,duration,data) self.markers[frame]={customData=data}; return not options.markerFailure end
    function i:GetMarkers() return self.markers end
    return i
  end
  local subtitles={item('s1','甲',108000,108030),item('s2','乙',108300,108360),__flags=256}
  if options.missingSentences then
    subtitles={item('s1','武夷山',15,45),item('s2','实际到来之前，我对它的印象',51,123),
      item('s4','但当实际走过山间的小路',1985,2051),__flags=256}
  end
  local audio={{},{},{}}
  if options.occupied then audio[2]={item('user','User audio',108000,108100)} end
  original={}
  function original:GetUniqueId() return 'timeline-1' end
  function original:GetName() return 'Timeline' end
  function original:GetSetting() return 30 end
  function original:GetTrackCount(kind) if kind=='subtitle' then return 1 elseif kind=='audio' then return #audio else return 0 end end
  function original:GetItemListInTrack(kind,track)
    if kind=='subtitle' then return subtitles end
    local list={__flags=256}; for i,c in ipairs(audio[track] or {}) do list[i]=c end; return list
  end
  function original:GetIsTrackEnabled(kind,track) return not (options.disabled and track==2) end
  function original:GetIsTrackLocked(kind,track) return options.locked==true and track==2 end
  function original:GetTrackName() return 'Kairos VO' end
  function original:AddTrack() audio[#audio+1]={}; return true end
  function original:SetTrackName() return true end
  function original:DuplicateTimeline(name)
    copies=copies+1; local recovery={GetUniqueId=function()return 'recovery'end,GetName=function()return name end}; current=recovery; return recovery
  end
  function original:DeleteClips(items)
    deletes=deletes+#items
    for _,victim in ipairs(items) do for _,track in ipairs(audio) do for idx=#track,1,-1 do if track[idx]==victim then table.remove(track,idx) end end end end
    return true
  end
  current=original
  pool={}
  function pool:GetRootFolder() return root end
  function pool:GetCurrentFolder() return currentFolder end
  function pool:SetCurrentFolder(f) currentFolder=f; return true end
  function pool:AddSubFolder(parent,name) local f=folder(name); table.insert(parent.children,f); return f end
  function pool:ImportMedia() imported=imported+1; table.insert(currentFolder.clips,media); return {media,__flags=256} end
  function pool:AppendToTimeline(plans)
    inserted=inserted+1
    if options.failSecond and inserted==2 then return nil end
    local plan=plans[1]
    local duration=math.ceil((plan.endFrame-plan.startFrame)*30/(options.sourceFps or 30)-0.0000001)
    if options.inclusiveAudioEnd then duration=duration+1 end
    local c=item('a'..inserted,'audio',plan.recordFrame,plan.recordFrame+duration,plan.startFrame,plan.endFrame)
    if options.wrongPosition then c.startFrame=c.startFrame+2 end
    table.insert(audio[plan.trackIndex],c); clips[#clips+1]=c
    return {c,__flags=256}
  end
  function pool:DeleteTimelines() return true end
  project={}
  function project:GetName() return 'Project' end
  function project:GetCurrentTimeline() return current end
  function project:SetCurrentTimeline(t) current=t; return true end
  function project:GetMediaPool() return pool end
  local manager={GetCurrentProject=function()return project end,SaveProject=function()saves=saves+1;return not(options.saveFailure and saves==2)end}
  _G.resolve={GetProjectManager=function()return manager end}
  local job={resolveProjectName='Project',timelineId='timeline-1',timelineName='Timeline',timelineFrameRate=30,subtitleTrackIndex=1,subtitles=plugin.collectSubtitles(1)}
  local result={alignmentVersion='subtitle-alignment-v1',unitCount=#job.subtitles,units={}}
  for idx,row in ipairs(job.subtitles) do
    result.units[idx]={unitId='unit-'..idx,requestHash='request',resolveAudioPath='/test/audio.mp3',recordFrame=row.startFrame,subtitleEndFrame=row.endFrame,
      subtitleIndex=row.subtitleIndex,alignmentStatus='aligned',durationStatus='ok',sourceStartMs=idx==1 and 150 or 1450,sourceEndMs=idx==1 and 850 or 2550}
  end
  if options.missingSentences then
    local ranges={{215,935},{1175,3795},{6230,8405}}
    for idx,unit in ipairs(result.units) do
      unit.sourceStartMs=ranges[idx][1]; unit.sourceEndMs=ranges[idx][2]
    end
    result.units[2].durationStatus='overflow'; result.units[2].overflowMs=233
  end
  return {job=job,result=result,subtitles=subtitles,audio=audio,clips=clips,
    stats=function()return {inserted=inserted,imported=imported,copies=copies,saves=saves,deletes=deletes}end}
end

-- Real first-run regression: one natural overrun and one frame-rounding overrun.
for _,inclusiveEnd in ipairs({false,true}) do
local regression=scenario({missingSentences=true,inclusiveAudioEnd=inclusiveEnd})
local endAdjustment=inclusiveEnd and 1 or 0
local partialJob={}
for key,value in pairs(regression.job) do partialJob[key]=value end
partialJob.subtitles={regression.job.subtitles[1]}
local partialResult={alignmentVersion=regression.result.alignmentVersion,unitCount=1,units={regression.result.units[1]}}
local partial=plugin.insertAlignedResult(partialJob,partialResult)
eq(partial.inserted,1); eq(partial.skipped,0)
local originalItem=regression.clips[1]
local repaired=plugin.insertAlignedResult(regression.job,regression.result)
eq(repaired.inserted,2); eq(repaired.skipped,1); eq(repaired.overflow,2)
eq(regression.stats().imported,1)
eq(regression.clips[1],originalItem); eq(originalItem.startFrame,15); eq(originalItem.endFrame,38+endAdjustment)
eq(regression.clips[2].startFrame,51); eq(regression.clips[2].endFrame,130+endAdjustment)
eq(regression.clips[3].startFrame,1985); eq(regression.clips[3].endFrame,2052+endAdjustment)
eq(regression.subtitles[2].endFrame,123); eq(regression.subtitles[3].endFrame,2051)
eq(plugin.insertAlignedResult(regression.job,regression.result).inserted,0)
eq(regression.stats().inserted,3)
end

-- Refresh must preserve the visible per-row status column.
local tree={ColumnCount=6,ColumnWidth={}}
function tree:SetHeaderLabels(labels) self.labels=labels end
plugin.applySubtitleTreeColumns(tree)
plugin.applySubtitleTreeColumns(tree)
eq(tree.ColumnCount,7); eq(#tree.labels,7); eq(tree.labels[7],'Voiceover')
assert(tree.ColumnWidth[6]>0)

local s=scenario()
eq(plugin.insertAlignedResult(s.job,s.result).inserted,2)
eq(s.stats().imported,1)
eq(plugin.insertAlignedResult(s.job,s.result).inserted,0)
eq(s.stats().copies,1)
s.clips[1].startFrame=s.clips[1].startFrame+5
eq(plugin.insertAlignedResult(s.job,s.result).inserted,0)
eq(s.clips[1].startFrame,108005)
-- A new tail policy must not append a duplicate over an older or hand-edited clip.
s.result.units[1].sourceEndMs=s.result.units[1].sourceEndMs+100
eq(plugin.insertAlignedResult(s.job,s.result).inserted,0)
eq(s.stats().inserted,2)

-- Live Resolve audio endFrame is an end boundary, and container padding is not media.
s=scenario({mediaDuration='00:00:24:00'})
local u=s.result.units[1]
u.sourceStartMs=8590; u.sourceEndMs=10170
eq(plugin.insertAlignedResult(s.job,s.result).inserted,2)
eq(s.clips[1].sourceStart,257); eq(s.clips[1].sourceEnd,306)
eq(s.clips[1].endFrame-s.clips[1].startFrame,49)
s=scenario({mediaDuration='00:00:24:00'})
s.result.units[2].sourceStartMs=21455; s.result.units[2].sourceEndMs=24072
eq(plugin.insertAlignedResult(s.job,s.result).inserted,2)
eq(s.clips[2].sourceEnd,720)

for _,options in ipairs({{occupied=true},{locked=true},{disabled=true},{sourceFps=24}}) do
  s=scenario(options)
  eq(plugin.insertAlignedResult(s.job,s.result).inserted,2)
  if not options.sourceFps then eq(#s.audio[2],options.occupied and 2 or 0) end
end

for _,options in ipairs({{failSecond=true},{markerFailure=true},{wrongPosition=true},{saveFailure=true}}) do
  s=scenario(options)
  local ok,message=pcall(plugin.insertAlignedResult,s.job,s.result)
  eq(ok,false); assert(tostring(message):find('rollback=true',1,true),message)
  for _,track in ipairs(s.audio) do eq(#track,0) end
end

s=scenario(); s.result.units[1].alignmentStatus='blocked'; s.result.units[1].alignmentReason='timestamp_text_mismatch'
s.result.units[2].durationStatus='overflow'; s.result.units[2].overflowMs=100
local mixed=plugin.insertAlignedResult(s.job,s.result)
eq(mixed.inserted,1); eq(mixed.skipped,1); eq(s.stats().imported,1)
s=scenario()
for _,unit in ipairs(s.result.units) do unit.alignmentStatus='blocked' end
eq(plugin.insertAlignedResult(s.job,s.result).inserted,0); eq(s.stats().copies,0); eq(s.stats().imported,0)
s=scenario(); s.subtitles[1].name='changed'
eq(pcall(plugin.insertAlignedResult,s.job,s.result),false); eq(s.stats().imported,0)
s=scenario(); s.result.alignmentVersion=nil
eq(pcall(plugin.insertAlignedResult,s.job,s.result),false); eq(s.stats().imported,0)
s=scenario(); s.result.units[2].recordFrame=1
eq(pcall(plugin.insertAlignedResult,s.job,s.result),false); eq(s.stats().imported,0)

local parsed=plugin.parseSynthesizeTsv('OK\tmanifest\t1\nALIGNMENT\tsubtitle-alignment-v1\nUNIT\tu\t/a.mp3\t108000\tok\t700\t1000\t-300\taligned\t\t150\t850\t1\tr\t108030\n')
eq(parsed.units[1].sourceStartMs,150); eq(parsed.units[1].subtitleEndFrame,108030)
print('VOICEOVER_LUA_OK')
