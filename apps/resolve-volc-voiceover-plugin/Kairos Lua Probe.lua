local function appendLog(message)
    local home = os.getenv("HOME") or "."
    local dir = home .. "/Movies/KairosVoiceover/logs"
    os.execute("/bin/mkdir -p " .. string.format("%q", dir))
    local file = io.open(dir .. "/lua-probe.log", "a")
    if file then
        file:write(os.date("[%Y-%m-%d %H:%M:%S] ") .. tostring(message) .. "\n")
        file:close()
    end
end

appendLog("lua probe start")

local ui = fusion and fusion.UIManager
local dispatcher = bmd and ui and bmd.UIDispatcher(ui)
appendLog("globals fusion=" .. tostring(fusion ~= nil) .. " bmd=" .. tostring(bmd ~= nil) .. " resolve=" .. tostring(resolve ~= nil))

if dispatcher then
    local winID = "com.dtysky.kairos.luaprobe"
    local win = dispatcher:AddWindow({
        ID = winID,
        Geometry = {180, 180, 420, 160},
        WindowTitle = "Kairos Lua Probe",
    },
    ui:VGroup({
        ui:Label({Text = "Kairos Lua Probe OK", Weight = 0}),
        ui:Button({ID = "close", Text = "Close"}),
    }))

    local function onClose(ev)
        appendLog("lua probe close")
        dispatcher:ExitLoop()
    end

    win.On[winID].Close = onClose
    win.On["close"].Clicked = onClose

    win:Show()
    appendLog("lua probe window shown")
    dispatcher:RunLoop()
end
