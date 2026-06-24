local WINDOW_ID = "kairosVolcVoiceover"
local PLUGIN_VERSION = "0.1.6"
local VOICE_TRACK_NAME = "Kairos VO"
local DEFAULT_RESOURCE_ID = "seed-icl-2.0"

local subtitles = {}
local subtitleTreeItems = {}
local items = nil
local root = "."
local voiceConfig = nil
local ui = nil
local getProjectName = nil
local cachedPluginTmpDir = nil
local cachedPluginTmpProject = nil

local function quote(value)
    return "'" .. tostring(value):gsub("'", "'\\''") .. "'"
end

local function dirname(path)
    return tostring(path):match("^(.*)/[^/]*$") or "."
end

local source = debug.getinfo(1, "S").source or ""
if source:sub(1, 1) == "@" then
    source = source:sub(2)
end
root = dirname(source)

local function readText(path)
    local file = io.open(path, "r")
    if not file then
        return ""
    end
    local text = file:read("*a") or ""
    file:close()
    return text
end

local function writeText(path, text)
    local file = io.open(path, "w")
    if not file then
        return false
    end
    file:write(text)
    file:close()
    return true
end

local function workspaceTmpDir()
    local linkText = readText(root .. "/KairosVolcVoiceoverLib/kairos_workspace.json")
    local workspaceRoot = linkText:match('"workspaceRoot"%s*:%s*"([^"]+)"') or ""
    workspaceRoot = workspaceRoot:gsub("\\/", "/")
    if workspaceRoot ~= "" then
        return workspaceRoot .. "/.tmp/resolve-volc-voiceover-plugin"
    end
    return (os.getenv("HOME") or ".") .. "/Movies/KairosVoiceover"
end

local function pluginTmpDir()
    local projectName = ""
    if type(getProjectName) == "function" then
        local ok, value = pcall(getProjectName)
        if ok then
            projectName = tostring(value or "")
        end
    end
    if cachedPluginTmpDir ~= nil and cachedPluginTmpProject == projectName then
        return cachedPluginTmpDir
    end
    local python = root .. "/KairosVolcVoiceoverLib/KairosVolcVoiceover.py"
    local cmd = "/usr/bin/python3 " .. quote(python) .. " --project-temp-root --project-name " .. quote(projectName) .. " 2>&1"
    local output = ""
    local pipe = io.popen(cmd)
    if pipe then
        output = pipe:read("*a") or ""
        pipe:close()
    end
    local tmp = output:match("TMP\t([^\r\n]+)")
    if tmp == nil or tmp == "" then
        tmp = workspaceTmpDir()
    end
    cachedPluginTmpDir = tmp
    cachedPluginTmpProject = projectName
    os.execute("/bin/mkdir -p " .. quote(tmp))
    return tmp
end

local function logDir()
    return pluginTmpDir() .. "/logs"
end

local function appendLog(message)
    local dir = logDir()
    os.execute("/bin/mkdir -p " .. quote(dir))
    local file = io.open(dir .. "/lua-plugin.log", "a")
    if file then
        file:write(os.date("[%Y-%m-%d %H:%M:%S] ") .. tostring(message) .. "\n")
        file:close()
    end
end

local function uiLog(message)
    appendLog(message)
    if items and items.log then
        local current = items.log.PlainText or ""
        local line = os.date("%H:%M:%S ") .. tostring(message)
        if current == "" then
            items.log.PlainText = line
        else
            items.log.PlainText = current .. "\n" .. line
        end
    end
end

local function safeCall(obj, method, ...)
    local objType = type(obj)
    if obj == nil or (objType ~= "table" and objType ~= "userdata") then
        return nil
    end
    local okLookup, fn = pcall(function()
        return obj[method]
    end)
    if not okLookup then
        return nil
    end
    if fn == nil then
        return nil
    end
    local ok, result = pcall(fn, obj, ...)
    if ok then
        return result
    end
    return nil
end

local function stringify(value)
    if value == nil or type(value) == "table" then
        return ""
    end
    return tostring(value)
end

local function trim(value)
    return tostring(value or ""):match("^%s*(.-)%s*$") or ""
end

local function cleanSubtitleText(value)
    local text = trim(value)
    text = text:gsub("<[^>]+>", "")
    text = text:gsub("\\N", "\n")
    text = text:gsub("%s+", " ")
    return trim(text)
end

local function jsonString(value)
    local replacements = {
        ['"'] = '\\"',
        ["\\"] = "\\\\",
        ["\b"] = "\\b",
        ["\f"] = "\\f",
        ["\n"] = "\\n",
        ["\r"] = "\\r",
        ["\t"] = "\\t",
    }
    local text = tostring(value or "")
    text = text:gsub('[%z\1-\31\\"]', function(char)
        return replacements[char] or string.format("\\u%04x", char:byte())
    end)
    return '"' .. text .. '"'
end

local function tsvUnescape(value)
    local text = tostring(value or "")
    text = text:gsub("\\n", "\n")
    text = text:gsub("\\t", "\t")
    text = text:gsub("\\\\", "\\")
    return text
end

local function splitTabs(line)
    local fields = {}
    local text = tostring(line or "")
    local start = 1
    while true do
        local tab = text:find("\t", start, true)
        if not tab then
            table.insert(fields, tsvUnescape(text:sub(start)))
            break
        end
        table.insert(fields, tsvUnescape(text:sub(start, tab - 1)))
        start = tab + 1
    end
    return fields
end

local function loadVoiceoverConfigSummary()
    local python = root .. "/KairosVolcVoiceoverLib/KairosVolcVoiceover.py"
    local cmd = "/usr/bin/python3 " .. quote(python) .. " --voiceover-config-summary --project-name " .. quote(type(getProjectName) == "function" and getProjectName() or "") .. " 2>&1"
    local output = ""
    local pipe = io.popen(cmd)
    if pipe then
        output = pipe:read("*a") or ""
        pipe:close()
    end
    local result = {
        runtimeConfigPath = "",
        hasApiKey = false,
        defaultProfile = "",
        backendVersion = "",
        profiles = {},
        error = "",
    }
    for line in output:gmatch("[^\r\n]+") do
        local fields = splitTabs(line)
        local kind = fields[1]
        if kind == "VERSION" then
            result.backendVersion = fields[2] or ""
        elseif kind == "CONFIG" then
            result.runtimeConfigPath = fields[2] or ""
        elseif kind == "HAS_API_KEY" then
            result.hasApiKey = fields[2] == "1"
        elseif kind == "DEFAULT" then
            result.defaultProfile = fields[2] or ""
        elseif kind == "PROFILE" then
            table.insert(result.profiles, {
                name = fields[2] or "",
                displayName = fields[3] or fields[2] or "",
            })
        elseif kind == "ERROR" then
            result.error = fields[2] or line
        end
    end
    return result
end

local function profileLabel(profile)
    local display = tostring(profile.displayName or profile.name or "")
    local name = tostring(profile.name or "")
    if display ~= "" and display ~= name then
        return display .. " (" .. name .. ")"
    end
    return name
end

local function profileLabels(config)
    local labels = {}
    for _, profile in ipairs(config.profiles or {}) do
        table.insert(labels, profileLabel(profile))
    end
    if #labels == 0 then
        table.insert(labels, "No profiles in config/runtime.json")
    end
    return labels
end

local function defaultProfileIndex(config)
    local defaultName = tostring(config.defaultProfile or "")
    for index, profile in ipairs(config.profiles or {}) do
        if defaultName ~= "" and profile.name == defaultName then
            return index - 1
        end
    end
    return 0
end

local function profileIndexByName(config, name)
    local profileName = tostring(name or "")
    if profileName == "" then
        return nil
    end
    for index, profile in ipairs(config.profiles or {}) do
        if profile.name == profileName then
            return index - 1
        end
    end
    return nil
end

local function preferredProfileIndex(config, preferredName)
    return profileIndexByName(config, preferredName) or defaultProfileIndex(config)
end

local function isArray(value)
    if type(value) ~= "table" then
        return false
    end
    local count = 0
    local maxIndex = 0
    for key, _ in pairs(value) do
        if type(key) ~= "number" then
            return false
        end
        count = count + 1
        if key > maxIndex then
            maxIndex = key
        end
    end
    return maxIndex == count
end

local function jsonEncode(value)
    local kind = type(value)
    if kind == "nil" then
        return "null"
    end
    if kind == "boolean" then
        return value and "true" or "false"
    end
    if kind == "number" then
        return tostring(value)
    end
    if kind == "string" then
        return jsonString(value)
    end
    if kind ~= "table" then
        return jsonString(tostring(value))
    end
    local parts = {}
    if isArray(value) then
        for index = 1, #value do
            table.insert(parts, jsonEncode(value[index]))
        end
        return "[" .. table.concat(parts, ",") .. "]"
    end
    for key, child in pairs(value) do
        table.insert(parts, jsonString(key) .. ":" .. jsonEncode(child))
    end
    return "{" .. table.concat(parts, ",") .. "}"
end

local function getResolve()
    if resolve ~= nil then
        return resolve
    end
    if bmd ~= nil and bmd.scriptapp ~= nil then
        return bmd.scriptapp("Resolve")
    end
    return nil
end

local function getProject()
    local currentResolve = getResolve()
    local manager = safeCall(currentResolve, "GetProjectManager")
    return safeCall(manager, "GetCurrentProject")
end

local function getTimeline()
    local project = getProject()
    return safeCall(project, "GetCurrentTimeline")
end

function getProjectName()
    local project = getProject()
    return tostring(safeCall(project, "GetName") or "Resolve Project")
end

local function getTimelineName()
    local timeline = getTimeline()
    return tostring(safeCall(timeline, "GetName") or "Timeline")
end

local function stableTimelineId()
    local timeline = getTimeline()
    local uniqueId = safeCall(timeline, "GetUniqueId")
    if uniqueId ~= nil and tostring(uniqueId) ~= "" then
        return tostring(uniqueId)
    end
    return getTimelineName()
end

local function fps()
    local project = getProject()
    local timeline = getTimeline()
    for _, obj in ipairs({timeline, project}) do
        local settings = safeCall(obj, "GetSetting")
        if type(settings) == "table" then
            for _, key in ipairs({"timelineFrameRate", "timelinePlaybackFrameRate"}) do
                local value = tonumber(settings[key])
                if value and value > 0 then
                    return value
                end
            end
        end
        for _, key in ipairs({"timelineFrameRate", "timelinePlaybackFrameRate"}) do
            local value = tonumber(safeCall(obj, "GetSetting", key))
            if value and value > 0 then
                return value
            end
        end
    end
    return 24.0
end

local function framesToMs(frames, frameRate)
    local value = tonumber(frames)
    if not value or frameRate <= 0 then
        return nil
    end
    return value * 1000.0 / frameRate
end

local function frameToTimecode(frame, frameRate)
    local frameValue = math.floor((tonumber(frame) or 0) + 0.5)
    local fpsInt = math.floor((frameRate or 24) + 0.5)
    if fpsInt <= 0 then
        fpsInt = 24
    end
    local totalSeconds = math.floor(math.max(frameValue, 0) / fpsInt)
    local framePart = math.max(frameValue, 0) % fpsInt
    local hours = math.floor(totalSeconds / 3600)
    local minutes = math.floor((totalSeconds % 3600) / 60)
    local seconds = totalSeconds % 60
    return string.format("%02d:%02d:%02d:%02d", hours, minutes, seconds, framePart)
end

local function timecodeToFrame(timecode, frameRate)
    local h, m, s, f = tostring(timecode or ""):match("^(%d+):(%d+):(%d+)[:;](%d+)")
    if not h then
        return nil
    end
    return math.floor(((tonumber(h) * 3600 + tonumber(m) * 60 + tonumber(s)) * frameRate) + tonumber(f) + 0.5)
end

local function timelineNumber(item, method)
    local value = safeCall(item, method)
    if value == nil then
        value = safeCall(item, method, false)
    end
    return tonumber(value)
end

local function extractSubtitleText(summary)
    local candidates = {summary.name}
    for _, mapName in ipairs({"property", "clipProperty"}) do
        local map = summary[mapName]
        if type(map) == "table" then
            for _, key in ipairs({"Text", "Subtitle", "Caption", "Name"}) do
                table.insert(candidates, map[key])
            end
        end
    end
    for _, candidate in ipairs(candidates) do
        local text = cleanSubtitleText(stringify(candidate))
        if text ~= "" then
            return text
        end
    end
    return ""
end

local function summarizeItem(item, trackIndex, index, frameRate)
    local startFrame = timelineNumber(item, "GetStart")
    local endFrame = timelineNumber(item, "GetEnd")
    local durationFrames = timelineNumber(item, "GetDuration")
    if startFrame == nil and endFrame ~= nil and durationFrames ~= nil then
        startFrame = endFrame - durationFrames
    end
    if endFrame == nil and startFrame ~= nil and durationFrames ~= nil then
        endFrame = startFrame + durationFrames
    end
    local property = safeCall(item, "GetProperty")
    if type(property) ~= "table" then
        property = {}
    end
    local clipProperty = safeCall(item, "GetClipProperty")
    if type(clipProperty) ~= "table" then
        clipProperty = {}
    end
    local summary = {
        trackType = "subtitle",
        trackIndex = trackIndex,
        subtitleIndex = index,
        name = tostring(safeCall(item, "GetName") or ""),
        startFrame = startFrame or 0,
        endFrame = endFrame or 0,
        durationFrames = durationFrames or ((endFrame or 0) - (startFrame or 0)),
        timelineInMs = framesToMs(startFrame, frameRate),
        timelineOutMs = framesToMs(endFrame, frameRate),
        durationMs = framesToMs(durationFrames, frameRate),
        property = property,
        clipProperty = clipProperty,
    }
    summary.text = extractSubtitleText(summary)
    summary.startTimecode = frameToTimecode(summary.startFrame, frameRate)
    summary.endTimecode = frameToTimecode(summary.endFrame, frameRate)
    return summary
end

local function collectSubtitles()
    local timeline = getTimeline()
    if not timeline then
        error("No current Resolve timeline.")
    end
    local frameRate = fps()
    local result = {}
    local trackCount = tonumber(safeCall(timeline, "GetTrackCount", "subtitle") or 0) or 0
    for trackIndex = 1, trackCount do
        local trackItems = safeCall(timeline, "GetItemListInTrack", "subtitle", trackIndex)
        if trackItems == nil then
            trackItems = safeCall(timeline, "GetItemsInTrack", "subtitle", trackIndex)
        end
        if type(trackItems) == "table" then
            for _, item in pairs(trackItems) do
                local itemType = type(item)
                if itemType == "table" or itemType == "userdata" then
                    table.insert(result, summarizeItem(item, trackIndex, #result + 1, frameRate))
                end
            end
        end
    end
    table.sort(result, function(left, right)
        if left.startFrame == right.startFrame then
            return left.trackIndex < right.trackIndex
        end
        return left.startFrame < right.startFrame
    end)
    for index, row in ipairs(result) do
        row.subtitleIndex = index
    end
    return result
end

local function setTreeItemText(item, column, value)
    local text = tostring(value or "")
    local ok = pcall(function()
        item.Text[column] = text
    end)
    if not ok then
        pcall(function()
            item.Text[column + 1] = text
        end)
    end
end

local function treeItemText(item, column)
    local ok, value = pcall(function()
        return item.Text[column]
    end)
    if ok and value ~= nil then
        return tostring(value)
    end
    ok, value = pcall(function()
        return item.Text[column + 1]
    end)
    if ok and value ~= nil then
        return tostring(value)
    end
    return ""
end

local function updateSelectionStatus()
    if not (items and items.selectionStatus and items.subtitleTree) then
        return
    end
    local count = 0
    local selected = safeCall(items.subtitleTree, "SelectedItems")
    if type(selected) == "table" then
        for _, item in pairs(selected) do
            local id = tonumber(treeItemText(item, 0))
            if id ~= nil then
                count = count + 1
            end
        end
    end
    items.selectionStatus.Text = "Selected: " .. tostring(count)
end

local function newTreeItem(tree)
    local item = safeCall(tree, "NewItem")
    if item ~= nil then
        return item
    end
    if ui and ui.TreeItem then
        local ok, created = pcall(function()
            return ui:TreeItem({})
        end)
        if ok then
            return created
        end
        ok, created = pcall(function()
            return ui:TreeItem()
        end)
        if ok then
            return created
        end
    end
    return nil
end

local function applySubtitleTreeColumns()
    if not (items and items.subtitleTree) then
        return
    end
    local tree = items.subtitleTree
    pcall(function()
        tree.ColumnCount = 6
    end)
    pcall(function()
        tree:SetHeaderLabels({"ID", "Track", "In", "Out", "Ms", "Text"})
    end)
    pcall(function()
        tree.ColumnWidth[0] = 42
        tree.ColumnWidth[1] = 48
        tree.ColumnWidth[2] = 88
        tree.ColumnWidth[3] = 88
        tree.ColumnWidth[4] = 58
        tree.ColumnWidth[5] = 390
    end)
end

local function renderSubtitleList()
    if not (items and items.subtitleTree) then
        return
    end
    local tree = items.subtitleTree
    safeCall(tree, "Clear")
    subtitleTreeItems = {}
    applySubtitleTreeColumns()
    for _, row in ipairs(subtitles) do
        local text = row.text
        if text == "" then
            text = "(no readable text)"
        end
        if #text > 120 then
            text = text:sub(1, 120) .. "..."
        end
        local item = newTreeItem(tree)
        if item ~= nil then
            setTreeItemText(item, 0, string.format("%03d", row.subtitleIndex))
            setTreeItemText(item, 1, "T" .. tostring(row.trackIndex))
            setTreeItemText(item, 2, row.startTimecode)
            setTreeItemText(item, 3, row.endTimecode)
            setTreeItemText(item, 4, string.format("%.0f", tonumber(row.durationMs or 0)))
            setTreeItemText(item, 5, text)
            safeCall(tree, "AddTopLevelItem", item)
            subtitleTreeItems[row.subtitleIndex] = item
        end
    end
    if #subtitles == 0 then
        local item = newTreeItem(tree)
        if item ~= nil then
            setTreeItemText(item, 0, "")
            setTreeItemText(item, 5, "No subtitle items found on the current timeline.")
            pcall(function()
                item.Disabled = true
            end)
            safeCall(tree, "AddTopLevelItem", item)
        end
    end
    updateSelectionStatus()
end

local function refreshSubtitles(ev)
    local ok, result = pcall(collectSubtitles)
    if not ok then
        uiLog("Refresh failed: " .. tostring(result))
        return
    end
    subtitles = result
    renderSubtitleList()
    uiLog("Loaded " .. tostring(#subtitles) .. " subtitle item(s).")
end

local function selectedIds()
    local ids = {}
    local seen = {}
    local selected = safeCall(items.subtitleTree, "SelectedItems")
    if type(selected) == "table" then
        for _, item in pairs(selected) do
            local value = tonumber(treeItemText(item, 0))
            if value and value >= 1 and value <= #subtitles and not seen[value] then
                table.insert(ids, value)
                seen[value] = true
            end
        end
    end
    table.sort(ids)
    return ids
end

local function setSelectedIds(ids, scrollToFirst)
    local wanted = {}
    local firstItem = nil
    for _, id in ipairs(ids) do
        local value = tonumber(id)
        if value and subtitleTreeItems[value] then
            wanted[value] = true
            if firstItem == nil then
                firstItem = subtitleTreeItems[value]
            end
        end
    end
    for id, item in pairs(subtitleTreeItems) do
        pcall(function()
            item.Selected = wanted[id] == true
        end)
    end
    if scrollToFirst and firstItem ~= nil then
        safeCall(items.subtitleTree, "ScrollToItem", firstItem)
    end
    updateSelectionStatus()
end

local function clearSelection(ev)
    for _, item in pairs(subtitleTreeItems) do
        pcall(function()
            item.Selected = false
        end)
    end
    updateSelectionStatus()
    uiLog("Cleared subtitle selection.")
end

local function selectIdsMatching(predicate, scrollToFirst)
    local ids = {}
    for _, row in ipairs(subtitles) do
        if predicate(row) then
            table.insert(ids, row.subtitleIndex)
        end
    end
    setSelectedIds(ids, scrollToFirst)
    return ids
end

local function currentFrame()
    local timeline = getTimeline()
    local timecode = safeCall(timeline, "GetCurrentTimecode")
    return timecodeToFrame(timecode, fps())
end

local function usePlayhead(ev)
    local frame = currentFrame()
    if frame == nil then
        uiLog("Unable to read playhead frame.")
        return
    end
    local ids = selectIdsMatching(function(row)
        if row.startFrame <= frame and frame < row.endFrame then
            return true
        end
        return false
    end, true)
    uiLog("Located " .. tostring(#ids) .. " subtitle(s) at frame " .. tostring(frame) .. ".")
end

local function rangesOverlap(leftStart, leftEnd, rightStart, rightEnd)
    return tonumber(leftStart) < tonumber(rightEnd) and tonumber(rightStart) < tonumber(leftEnd)
end

local function markRange()
    local timeline = getTimeline()
    local mark = safeCall(timeline, "GetMarkInOut")
    if type(mark) ~= "table" then
        return nil
    end
    for _, key in ipairs({"all", "video", "audio"}) do
        local current = mark[key]
        if type(current) == "table" and current["in"] ~= nil and current["out"] ~= nil then
            return tonumber(current["in"]), tonumber(current["out"])
        end
    end
    if mark["in"] ~= nil and mark["out"] ~= nil then
        return tonumber(mark["in"]), tonumber(mark["out"])
    end
    return nil
end

local function useMark(ev)
    local markIn, markOut = markRange()
    if not markIn or not markOut then
        uiLog("No Resolve In/Out range found. Set it on the timeline with I and O, then click Select Resolve I/O.")
        return
    end
    local ids = selectIdsMatching(function(row)
        if rangesOverlap(markIn, markOut, row.startFrame, row.endFrame) then
            return true
        end
        return false
    end, true)
    uiLog("Selected " .. tostring(#ids) .. " subtitle(s) in Resolve In/Out.")
end

local function selectedSubtitles()
    local selected = {}
    for _, id in ipairs(selectedIds()) do
        table.insert(selected, subtitles[id])
    end
    return selected
end

local function selectedProfile()
    if not voiceConfig or #(voiceConfig.profiles or {}) == 0 then
        return nil
    end
    local index = tonumber(items.profile.CurrentIndex)
    if index ~= nil then
        if voiceConfig.profiles[index + 1] then
            return voiceConfig.profiles[index + 1]
        end
        if voiceConfig.profiles[index] then
            return voiceConfig.profiles[index]
        end
    end
    local currentText = tostring(items.profile.CurrentText or items.profile.Text or "")
    for _, profile in ipairs(voiceConfig.profiles) do
        if profileLabel(profile) == currentText or profile.name == currentText then
            return profile
        end
    end
    return voiceConfig.profiles[1]
end

local function currentSettings()
    local profile = selectedProfile()
    return {
        profileName = profile and profile.name or "",
        speedRatio = items.speed.Text or "",
        loudnessRatio = items.loudness.Text or "",
    }
end

local function openRuntimeConfig(ev)
    if voiceConfig and voiceConfig.runtimeConfigPath ~= "" then
        os.execute("/usr/bin/open " .. quote(voiceConfig.runtimeConfigPath))
        uiLog("Opened voice config. Save it, then click Reload.")
    else
        uiLog("No Kairos runtime config path found.")
    end
end

local function voiceConfigStatusLine()
    if not voiceConfig then
        return "Voice config: not loaded"
    end
    if voiceConfig.error ~= "" then
        return "Voice config error: " .. voiceConfig.error
    end
    local defaultName = tostring(voiceConfig.defaultProfile or "")
    local suffix = ""
    if defaultName ~= "" then
        suffix = ", default=" .. defaultName
    end
    if tostring(voiceConfig.runtimeConfigPath or "") ~= "" then
        suffix = suffix .. ", path=" .. tostring(voiceConfig.runtimeConfigPath)
    end
    if tostring(voiceConfig.backendVersion or "") ~= "" then
        suffix = suffix .. ", backend=" .. tostring(voiceConfig.backendVersion)
    end
    return "Voice config: " .. tostring(#(voiceConfig.profiles or {})) .. " profile(s), "
        .. "apiKey=" .. (voiceConfig.hasApiKey and "configured" or "missing")
        .. suffix
end

local function replaceProfileItems(labels, currentIndex)
    if not (items and items.profile) then
        return false
    end
    local combo = items.profile
    local ok = pcall(function()
        combo:Clear()
        combo:AddItems(labels)
        combo.CurrentIndex = currentIndex or 0
    end)
    if ok then
        return true
    end
    ok = pcall(function()
        combo:Clear()
        for _, labelText in ipairs(labels) do
            combo:AddItem(labelText)
        end
        combo.CurrentIndex = currentIndex or 0
    end)
    return ok
end

local function reloadVoiceoverConfig(silent)
    local previousName = ""
    if voiceConfig and items and items.profile then
        local previous = selectedProfile()
        previousName = previous and previous.name or ""
    end
    voiceConfig = loadVoiceoverConfigSummary()
    local labels = profileLabels(voiceConfig)
    local updated = replaceProfileItems(labels, preferredProfileIndex(voiceConfig, previousName))
    if silent ~= true then
        uiLog(voiceConfigStatusLine())
        if not updated then
            uiLog("Profile dropdown did not update live. Close and reopen the panel.")
        end
    end
    return updated
end

local function runBackend(mode)
    reloadVoiceoverConfig(true)
    local selected = selectedSubtitles()
    if #selected == 0 then
        uiLog("No subtitle rows selected.")
        return
    end
    if not selectedProfile() then
        uiLog("No voice profile configured. Add voiceover.profiles[] in config/runtime.json.")
        return
    end
    if not (voiceConfig and voiceConfig.hasApiKey) then
        uiLog("Volcengine API key missing. Set voiceover.volcApiKey in config/runtime.json.")
        return
    end
    local job = {
        mode = mode,
        projectName = getProjectName(),
        timelineName = getTimelineName(),
        timelineId = stableTimelineId(),
        runId = os.date("%Y%m%d-%H%M%S"),
        subtitles = selected,
        settings = currentSettings(),
        skipOverflow = items.skipOverflow.Checked == true,
    }
    local tmpDir = pluginTmpDir() .. "/jobs"
    os.execute("/bin/mkdir -p " .. quote(tmpDir))
    local stamp = os.date("%Y%m%d-%H%M%S")
    local jobPath = tmpDir .. "/lua-job-" .. stamp .. ".json"
    local outPath = tmpDir .. "/lua-job-" .. stamp .. ".out"
    if not writeText(jobPath, jsonEncode(job) .. "\n") then
        uiLog("Unable to write job file: " .. jobPath)
        return
    end
    local python = root .. "/KairosVolcVoiceoverLib/KairosVolcVoiceover.py"
    local cmd = "/usr/bin/python3 " .. quote(python) .. " --synthesize-job " .. quote(jobPath) .. " > " .. quote(outPath) .. " 2>&1"
    appendLog("backend " .. cmd)
    if #selected > 1 then
        uiLog("Running backend for " .. tostring(#selected) .. " subtitle(s) as one merged voiceover...")
    else
        uiLog("Running backend for 1 subtitle...")
    end
    local result = os.execute(cmd)
    local output = readText(outPath)
    if output ~= "" then
        uiLog(output)
    else
        uiLog("Backend finished: " .. tostring(result))
    end
end

local function synthesizeInsert(ev)
    runBackend("insert")
end

local function probe(ev)
    local project = getProject()
    local timeline = getTimeline()
    if not project or not timeline then
        uiLog("Probe failed: no current project/timeline.")
        return
    end
    uiLog(
        "Probe OK: project=" .. getProjectName()
        .. ", timeline=" .. getTimelineName()
        .. ", fps=" .. tostring(fps())
        .. ", subtitles=" .. tostring(#subtitles)
        .. ", voiceTrack=" .. VOICE_TRACK_NAME
    )
end

local function openLogs(ev)
    os.execute("/usr/bin/open " .. quote(logDir()))
end

appendLog("lua plugin start root=" .. tostring(root))
ui = fusion and fusion.UIManager
local dispatcher = bmd and ui and bmd.UIDispatcher(ui)
appendLog("globals fusion=" .. tostring(fusion ~= nil) .. " bmd=" .. tostring(bmd ~= nil) .. " resolve=" .. tostring(resolve ~= nil))

if not dispatcher then
    appendLog("dispatcher unavailable")
    return
end

local existing = ui:FindWindow(WINDOW_ID)
if existing then
    existing:Show()
    existing:Raise()
    return
end

local smallFont = ui:Font({PixelSize = 12})
local titleFont = ui:Font({PixelSize = 13})

local function button(id, text, width)
    return ui:Button({
        ID = id,
        Text = text,
        Weight = 0,
        Font = smallFont,
        MinimumSize = {width, 24},
        MaximumSize = {width, 24},
    })
end

local function label(text, width)
    return ui:Label({
        Text = text,
        Weight = 0,
        Font = smallFont,
        MinimumSize = {width, 22},
        MaximumSize = {width, 22},
    })
end

local function lineEdit(id, text, placeholder, width)
    return ui:LineEdit({
        ID = id,
        Text = text or "",
        PlaceholderText = placeholder or "",
        Weight = 0,
        Font = smallFont,
        MinimumSize = {width, 24},
        MaximumSize = {width, 24},
    })
end

voiceConfig = {
    runtimeConfigPath = "",
    hasApiKey = false,
    defaultProfile = "",
    profiles = {},
    error = "",
}
local initialProfileLabels = {"Loading profiles..."}
local win = dispatcher:AddWindow({
    ID = WINDOW_ID,
    Geometry = {160, 160, 760, 420},
    WindowTitle = "Kairos Volc Voiceover " .. PLUGIN_VERSION,
},
ui:VGroup({
    ui:Label({Text = "Kairos Volc Voiceover " .. PLUGIN_VERSION, Weight = 0, Font = titleFont, MaximumSize = {760, 22}}),
    ui:HGroup({Weight = 0, MaximumSize = {760, 28}}, {
        button("refresh", "Refresh", 86),
        button("playhead", "Locate", 68),
        button("mark", "Resolve I/O", 92),
        button("clearSelection", "Clear", 58),
        button("probe", "Probe", 58),
        button("openLogs", "Logs", 54),
        ui:Label({
            ID = "selectionStatus",
            Text = "Selected: 0",
            Weight = 1,
            Font = smallFont,
            MinimumSize = {92, 22},
            MaximumSize = {760, 22},
        }),
    }),
    ui:Tree({
        ID = "subtitleTree",
        Weight = 0.74,
        ColumnCount = 6,
        HeaderHidden = false,
        RootIsDecorated = false,
        AlternatingRowColors = true,
        AllColumnsShowFocus = true,
        SelectionBehavior = "SelectRows",
        SelectionMode = "ExtendedSelection",
        UniformRowHeights = true,
        Font = smallFont,
    }),
    ui:HGroup({Weight = 0, MaximumSize = {760, 28}}, {
        label("Voice", 44),
        ui:ComboBox({
            ID = "profile",
            Items = initialProfileLabels,
            CurrentIndex = 0,
            Weight = 0,
            Font = smallFont,
            MinimumSize = {190, 24},
            MaximumSize = {190, 24},
        }),
        label("Speed", 42),
        lineEdit("speed", "", "default", 76),
        label("Gain", 34),
        lineEdit("loudness", "", "default", 76),
        button("openConfig", "Config", 62),
        button("reloadConfig", "Reload", 62),
    }),
    ui:HGroup({Weight = 0, MaximumSize = {760, 28}}, {
        ui:CheckBox({
            ID = "skipOverflow",
            Text = "Skip overflow",
            Checked = false,
            Weight = 0,
            Font = smallFont,
            MinimumSize = {120, 24},
            MaximumSize = {120, 24},
        }),
        button("synthesizeInsert", "Insert", 86),
        button("close", "Close", 64),
    }),
    ui:TextEdit({
        ID = "log",
        Weight = 0.24,
        ReadOnly = true,
        AcceptRichText = false,
        Font = smallFont,
    }),
}))

if not win then
    appendLog("window creation failed")
    return
end

items = win:GetItems()
local initialProfileReloaded = reloadVoiceoverConfig(true)

local function onClose(ev)
    appendLog("lua plugin close")
    dispatcher:ExitLoop()
end

win.On[WINDOW_ID].Close = onClose
win.On["close"].Clicked = onClose
win.On["refresh"].Clicked = refreshSubtitles
win.On["playhead"].Clicked = usePlayhead
win.On["mark"].Clicked = useMark
win.On["clearSelection"].Clicked = clearSelection
win.On["subtitleTree"].ItemSelectionChanged = updateSelectionStatus
win.On["probe"].Clicked = probe
win.On["openLogs"].Clicked = openLogs
win.On["openConfig"].Clicked = openRuntimeConfig
win.On["reloadConfig"].Clicked = reloadVoiceoverConfig
win.On["synthesizeInsert"].Clicked = synthesizeInsert

win:Show()
appendLog("lua plugin window shown")
refreshSubtitles(nil)
uiLog(voiceConfigStatusLine())
if not initialProfileReloaded then
    uiLog("Profile dropdown did not update during startup. Click Reload.")
end
dispatcher:RunLoop()
