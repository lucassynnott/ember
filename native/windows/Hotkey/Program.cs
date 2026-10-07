using System.Diagnostics;
using System.Runtime.InteropServices;
using System.Text.Json;
using System.Text;
using System.Windows.Automation;
using Forms = System.Windows.Forms;

internal static class Program
{
    delegate nint HookProc(int code, nint message, nint data);
    [StructLayout(LayoutKind.Sequential)] struct KeyEvent { public uint vk, scan, flags, time; public nuint extra; }
    [StructLayout(LayoutKind.Sequential)] struct KeyboardInput { public ushort vk, scan; public uint flags, time; public nuint extra; }
    [StructLayout(LayoutKind.Sequential)] struct MouseInput { public int x, y; public uint data, flags, time; public nuint extra; }
    [StructLayout(LayoutKind.Explicit)] struct InputUnion { [FieldOffset(0)] public KeyboardInput keyboard; [FieldOffset(0)] public MouseInput mouse; }
    [StructLayout(LayoutKind.Sequential)] struct Input { public uint type; public InputUnion value; }
    [DllImport("user32.dll", SetLastError = true)] static extern nint SetWindowsHookExW(int kind, HookProc proc, nint module, uint thread);
    [DllImport("user32.dll")] static extern bool UnhookWindowsHookEx(nint hook);
    [DllImport("user32.dll")] static extern nint CallNextHookEx(nint hook, int code, nint message, nint data);
    [DllImport("kernel32.dll", CharSet = CharSet.Unicode)] static extern nint GetModuleHandleW(string? name);
    [DllImport("user32.dll")] static extern nint GetForegroundWindow();
    [DllImport("user32.dll")] static extern uint GetWindowThreadProcessId(nint hwnd, out uint pid);
    [DllImport("user32.dll")] static extern bool SetForegroundWindow(nint hwnd);
    [DllImport("user32.dll", SetLastError = true)] static extern uint SendInput(uint count, Input[] inputs, int size);
    [DllImport("user32.dll")] static extern uint GetClipboardSequenceNumber();
    [DllImport("user32.dll")] static extern bool IsClipboardFormatAvailable(uint format);
    [DllImport("user32.dll", CharSet = CharSet.Unicode)] static extern uint RegisterClipboardFormatW(string name);
    [DllImport("user32.dll")] static extern short GetAsyncKeyState(int key);

    delegate bool EnumWindowsProc(nint hwnd, nint parameter);
    [StructLayout(LayoutKind.Sequential)] struct Rect { public int left, top, right, bottom; }
    [StructLayout(LayoutKind.Sequential)] struct Point { public int x, y; }
    [StructLayout(LayoutKind.Sequential)] struct CursorInfo { public uint size, flags; public nint cursor; public Point point; }
    [DllImport("user32.dll")] static extern bool EnumWindows(EnumWindowsProc callback, nint parameter);
    [DllImport("user32.dll")] static extern bool IsWindowVisible(nint hwnd);
    [DllImport("user32.dll")] static extern bool IsIconic(nint hwnd);
    [DllImport("user32.dll", CharSet = CharSet.Unicode)] static extern int GetWindowTextW(nint hwnd, StringBuilder text, int max);
    [DllImport("user32.dll")] static extern bool GetWindowRect(nint hwnd, out Rect bounds);
    [DllImport("dwmapi.dll")] static extern int DwmGetWindowAttribute(nint hwnd, uint attribute, out Rect value, int size);
    [DllImport("user32.dll")] static extern bool GetCursorInfo(ref CursorInfo info);
    [DllImport("user32.dll")] static extern nint LoadCursorW(nint instance, nint name);
    static bool watchingPointer;
    static readonly int[] CursorIds = [32512, 32513, 32649, 32649, 32649, 32515, 32644, 32645, 32648];
    static List<object> Windows()
    {
        var windows = new List<object>();
        EnumWindows((hwnd, _) => {
            if (!IsWindowVisible(hwnd) || IsIconic(hwnd)) return true;
            var title = new StringBuilder(2048);
            GetWindowTextW(hwnd, title, title.Capacity);
            if (title.Length == 0) return true;
            if (DwmGetWindowAttribute(hwnd, 9, out var rect, Marshal.SizeOf<Rect>()) != 0 && !GetWindowRect(hwnd, out rect)) return true;
            GetWindowThreadProcessId(hwnd, out var pid);
            string app = "";
            try { using var process = Process.GetProcessById((int)pid); app = process.ProcessName; } catch { }
            windows.Add(new { id=hwnd.ToInt64(), pid, app, title=title.ToString(), bounds=new { x=rect.left, y=rect.top, width=rect.right-rect.left, height=rect.bottom-rect.top } });
            return true;
        }, 0);
        return windows;
    }
    static void Pointer()
    {
        if (!watchingPointer) return;
        var info = new CursorInfo { size=(uint)Marshal.SizeOf<CursorInfo>() };
        if (!GetCursorInfo(ref info)) return;
        int shape = Array.FindIndex(CursorIds, cursor => LoadCursorW(0, cursor) == info.cursor);
        Emit(new { @event="pointer", x=info.point.x, y=info.point.y, pressed=GetAsyncKeyState(1) < 0, shape=shape < 0 ? 0 : shape, visible=(info.flags & 1) != 0 });
    }

    // The persisted shortcut schema uses macOS key codes on both platforms.
    static readonly Dictionary<int, int> KeyMap = new() {
        [0]=65,[1]=83,[2]=68,[3]=70,[4]=72,[5]=71,[6]=90,[7]=88,[8]=67,[9]=86,[11]=66,
        [12]=81,[13]=87,[14]=69,[15]=82,[16]=89,[17]=84,[18]=49,[19]=50,[20]=51,[21]=52,
        [22]=54,[23]=53,[24]=187,[25]=57,[26]=55,[27]=189,[28]=56,[29]=48,[30]=221,[31]=79,
        [32]=85,[33]=219,[34]=73,[35]=80,[36]=13,[37]=76,[38]=74,[39]=222,[40]=75,[41]=186,
        [42]=220,[43]=188,[44]=191,[45]=78,[46]=77,[47]=190,[48]=9,[49]=32,[50]=192,[51]=8,
        [53]=27,[57]=20,[65]=110,[67]=106,[69]=107,[71]=12,[75]=111,[76]=13,[78]=109,[81]=187,
        [82]=96,[83]=97,[84]=98,[85]=99,[86]=100,[87]=101,[88]=102,[89]=103,[91]=104,[92]=105,
        [122]=112,[120]=113,[99]=114,[118]=115,[96]=116,[97]=117,[98]=118,[100]=119,[101]=120,
        [109]=121,[103]=122,[111]=123,[105]=124,[107]=125,[113]=126,[106]=127,[64]=128,
        [79]=129,[80]=130,[90]=131,[114]=45,[115]=36,[116]=33,[117]=46,[119]=35,[121]=34,
        [123]=37,[124]=39,[125]=40,[126]=38
    };
    static readonly Dictionary<int, string> Modifiers = new() {
        [160]="leftShift", [161]="rightShift", [162]="leftControl", [163]="rightControl",
        [164]="leftOption", [165]="rightOption", [91]="leftCommand", [92]="rightCommand"
    };
    sealed class Slot { public int? key; public HashSet<string> modifiers = []; public bool active; }
    static readonly Dictionary<string, Slot> Slots = [];
    static readonly HashSet<string> Held = [];
    static readonly HashSet<int> Keys = [];
    static readonly HashSet<int> Suppressed = [];
    static readonly HookProc Callback = OnKey;
    static nint hook;
    static bool capturing, dictating, watching, readingClipboard;
    static HashSet<string> captureModifiers = [];
    static uint clipboardSequence;
    static int pendingCommands;
    static bool inputClosed;
    static readonly Forms.Control Dispatcher = new();
    static void Emit(object value) { Console.WriteLine(JsonSerializer.Serialize(value)); Console.Out.Flush(); }
    static void Event(string name, string? slot = null) => Emit(new { @event = name, hotkey = slot });

    [STAThread] static void Main(string[] args)
    {
        if(args.Length>0) {
            try {
                if(args.Length==1 && args[0]=="cloud-files") { if(!OperatingSystem.IsWindowsVersionAtLeast(10,0,16299)) throw new PlatformNotSupportedException("Ember Drive requires Windows 10 version 1709 or later."); CloudFiles.Run(); return; }
                if(args.Length==1 && (args[0]=="observe-audio" || args[0]=="audio-apps")) { AudioApps.Run(args[0]=="audio-apps"); return; }
                if(args.Length==3 && args[0]=="extract-rtf" && args[1]=="--file") {
                    if(new System.IO.FileInfo(args[2]).Length>30*1024*1024) throw new InvalidOperationException("Document exceeds the 30 MB limit.");
                    Console.OutputEncoding=new System.Text.UTF8Encoding(false);
                    using var reader=new Forms.RichTextBox();
                    reader.LoadFile(args[2], Forms.RichTextBoxStreamType.RichText);
                    Console.Write(reader.Text);
                    return;
                }
                if(args.Length!=3 || !new[]{"capture","capture-test","capture-cancel-test","capture-window-test"}.Contains(args[0]) || args[1]!="--out") throw new InvalidOperationException("Expected capture --out <PNG path>.");
                ScreenCapture.Run(args[2],args[0] switch {"capture-test"=>1,"capture-cancel-test"=>2,"capture-window-test"=>3,_=>0});
            } catch(Exception error) {Console.Error.WriteLine(error.Message);Environment.Exit(1);}
            return;
        }
        Forms.Application.SetHighDpiMode(Forms.HighDpiMode.PerMonitorV2);
        _ = Dispatcher.Handle;
        hook = SetWindowsHookExW(13, Callback, GetModuleHandleW(null), 0);
        if (hook == 0) { Console.Error.WriteLine($"Keyboard hook failed: {Marshal.GetLastWin32Error()}"); Environment.Exit(1); }
        foreach (var modifier in Modifiers) if (GetAsyncKeyState(modifier.Key) < 0) Held.Add(modifier.Value);
        Emit(new { @event = "status", accessibility = true, tap = true });
        using var timer = new Forms.Timer { Interval = 500 };
        timer.Tick += (_, _) => WatchClipboard();
        timer.Start();
        using var pointerTimer = new Forms.Timer { Interval = 16 };
        pointerTimer.Tick += (_, _) => Pointer();
        pointerTimer.Start();
        _ = Task.Run(() => {
            string? line;
            while ((line = Console.ReadLine()) != null) {
                try {
                    var command = JsonDocument.Parse(line).RootElement.Clone();
                    Dispatcher.BeginInvoke(() => Handle(command));
                } catch (Exception e) { Console.Error.WriteLine(e.Message); }
            }
            Dispatcher.BeginInvoke(() => { inputClosed = true; if (pendingCommands == 0) Forms.Application.ExitThread(); });
        });
        try { Forms.Application.Run(); } finally { UnhookWindowsHookEx(hook); Dispatcher.Dispose(); }
    }
    static nint OnKey(int code, nint message, nint data)
    {
        if (code < 0) return CallNextHookEx(hook, code, message, data);
        var key = Marshal.PtrToStructure<KeyEvent>(data);
        if ((key.flags & 0x10) != 0) return CallNextHookEx(hook, code, message, data); // Ignore injected copy/paste.
        bool down = message == 0x100 || message == 0x104;
        int vk = (int)key.vk;
        bool repeat = down && !Keys.Add(vk);
        if (!down) Keys.Remove(vk);
        bool modifier = Modifiers.TryGetValue(vk, out var modifierName);
        if (modifier) { if (down) Held.Add(modifierName!); else Held.Remove(modifierName!); }
        bool swallow = !down && Suppressed.Remove(vk);
        if (capturing) {
            if (down && vk == 27) { capturing = false; Event("captureCancelled"); }
            else if (modifier) {
                if (Held.Count > captureModifiers.Count) captureModifiers = new(Held);
                if (!down && Held.Count == 0 && captureModifiers.Count > 0) FinishCapture(null, null);
            } else if (down && !repeat) {
                var mapped = KeyMap.FirstOrDefault(pair => pair.Value == vk);
                if (KeyMap.ContainsKey(mapped.Key) && mapped.Value == vk) {
                    captureModifiers = new(Held);
                    FinishCapture(mapped.Key, ((Forms.Keys)vk).ToString());
                }
            }
            swallow = true;
        } else if (vk == 27 && dictating) { if (down && !repeat) Event("escape"); swallow = true; }
        else {
            foreach (var pair in Slots.OrderBy(pair => pair.Key)) {
                var slot = pair.Value;
                bool chord = Held.SetEquals(slot.modifiers);
                if (slot.key != null) {
                    if (down && vk == slot.key.Value && chord && !repeat) { slot.active = true; Event("down", pair.Key); }
                    if (down && vk == slot.key.Value && slot.active) { Suppressed.Add(vk); swallow = true; }
                    if (!down && vk == slot.key.Value && slot.active) { slot.active = false; Event("up", pair.Key); swallow = true; }
                } else if (modifier) {
                    if (!slot.active && chord && Held.Count > 0) { slot.active = true; Event("down", pair.Key); }
                    else if (slot.active && !chord) { slot.active = false; Event(slot.modifiers.IsSubsetOf(Held) ? "cancel" : "up", pair.Key); }
                } else if (slot.active && down && !repeat) { slot.active = false; Event("cancel", pair.Key); }
            }
        }
        return swallow ? 1 : CallNextHookEx(hook, code, message, data);
    }
    static void FinishCapture(int? keyCode, string? keyName) {
        capturing = false;
        Emit(new { @event = "captured", keyCode, keyName, modifiers = captureModifiers });
    }
    static readonly SemaphoreSlim FocusInspectionGate = new(1,1);
    static async Task<Dictionary<string, object?>> Focus()
    {
        // UI Automation can stall inside another application's provider. Keep
        // at most one inspection in flight, and never authorize paste on timeout.
        if(!FocusInspectionGate.Wait(0))return ForegroundInfo(GetForegroundWindow());
        var foreground=GetForegroundWindow();
        var inspection=Task.Run(()=>{try{return InspectFocus(foreground);}finally{FocusInspectionGate.Release();}});
        if(await Task.WhenAny(inspection,Task.Delay(1000))!=inspection){
            var fallback=ForegroundInfo(GetForegroundWindow());fallback["accessibilityTimedOut"]=true;return fallback;
        }
        var result=await inspection;
        return GetForegroundWindow()==foreground?result:ForegroundInfo(GetForegroundWindow());
    }
    static Dictionary<string, object?> ForegroundInfo(nint foreground)
    {
        var info=new Dictionary<string,object?>{["event"]="focus",["editable"]=false,["secure"]=true,["accessibility"]=true,["focusFound"]=false,["chromium"]=false};
        GetWindowThreadProcessId(foreground,out var pid);info["pid"]=pid;
        try{
            using var process=Process.GetProcessById((int)pid);info["app"]=process.ProcessName;info["bundleId"]=process.ProcessName.ToLowerInvariant();
            info["chromium"]=new[]{"chrome","msedge","brave","electron","code","discord"}.Contains(process.ProcessName.ToLowerInvariant());
        }catch(Exception e){Console.Error.WriteLine($"Foreground inspection: {e.Message}");}
        return info;
    }
    static Dictionary<string, object?> InspectFocus(nint foreground)
    {
        var info=ForegroundInfo(foreground);GetWindowThreadProcessId(foreground,out var pid);
        try {
            var element = AutomationElement.FocusedElement;
            if (element == null || element.Current.ProcessId != pid) return info;
            var current = element.Current;
            info["focusFound"] = true; info["secure"] = current.IsPassword; info["role"] = current.ControlType.ProgrammaticName;
            if (current.IsPassword) return info;
            if ((bool)info["chromium"]! && (current.ControlType == ControlType.Document || current.ControlType == ControlType.Pane || current.ControlType == ControlType.Custom)) {
                var descendant=WindowsAccessibility.Focus(foreground);
                if(GetForegroundWindow()!=foreground || descendant==null){info["secure"]=true;return info;}
                info["secure"]=descendant.Value.secure;info["editable"]=descendant.Value.editable;
                info["role"]=$"MSAA:{descendant.Value.role}";
                if(descendant.Value.secure)return info;
            }
            info["editable"] = (bool)info["editable"]! || (element.TryGetCurrentPattern(ValuePattern.Pattern, out var value) && !((ValuePattern)value).Current.IsReadOnly)
                || current.ControlType == ControlType.Edit;
            if (element.TryGetCurrentPattern(TextPattern.Pattern, out var text)) {
                info["selectedText"] = string.Join("", ((TextPattern)text).GetSelection().Select(range => range.GetText(20000)));
            }
        } catch (Exception e) { Console.Error.WriteLine($"Focus inspection: {e.Message}"); }
        return info;
    }
    static Task<string?> BrowserUrl(string? expectedProcess) => Task.Run(() => {
        nint window = GetForegroundWindow();
        GetWindowThreadProcessId(window, out var pid);
        if (window == 0 || pid == 0) return null;
        using var process = Process.GetProcessById((int)pid);
        string browser = process.ProcessName.ToLowerInvariant();
        if (browser != expectedProcess || !new[] { "chrome", "msedge", "brave", "vivaldi", "firefox", "opera", "chromium" }.Contains(browser)) return null;
        var root = AutomationElement.FromHandle(window);
        var edits = root.FindAll(TreeScope.Descendants, new PropertyCondition(AutomationElement.ControlTypeProperty, ControlType.Edit));
        string[] ids = { "urlbar", "omnibox", "addressEditBox", "addressbar", "urlBar" };
        string[] names = { "Address and search bar", "Search or enter address", "Address bar", "Search with Google or enter address", "Search with Bing or enter address" };
        foreach (AutomationElement element in edits) {
            var current = element.Current;
            if (current.IsPassword || current.ProcessId != pid || current.IsOffscreen) continue;
            if (!ids.Contains(current.AutomationId, StringComparer.OrdinalIgnoreCase) && !names.Contains(current.Name, StringComparer.OrdinalIgnoreCase)) continue;
            if (!element.TryGetCurrentPattern(ValuePattern.Pattern, out var pattern)) continue;
            string text = ((ValuePattern)pattern).Current.Value.Trim();
            if (!text.Contains("://")) {
                var actual=WindowsAccessibility.DocumentUrl(window,text);
                if(actual==null)continue;
                text=actual;
            }
            if (Uri.TryCreate(text, UriKind.Absolute, out var url) && (url.Scheme == "http" || url.Scheme == "https") && !string.IsNullOrEmpty(url.Host) && string.IsNullOrEmpty(url.UserInfo)) {
                if (GetForegroundWindow() != window) return null;
                return url.AbsoluteUri;
            }
        }
        return null;
    });
    static void PressControl(int key)
    {
        Input Make(int vk, bool up) => new() { type = 1, value = new InputUnion { keyboard = new KeyboardInput { vk=(ushort)vk, flags=up ? 2u : 0u } } };
        var inputs = new[] { Make(17, false), Make(key, false), Make(key, true), Make(17, true) };
        if (SendInput((uint)inputs.Length, inputs, Marshal.SizeOf<Input>()) != inputs.Length)
            throw new InvalidOperationException("Windows blocked input into the foreground app. Elevated apps require matching privileges.");
    }
    static async void WatchClipboard()
    {
        if (!watching || readingClipboard) return;
        var sequence = GetClipboardSequenceNumber();
        if (sequence == clipboardSequence) return;
        clipboardSequence = sequence;
        readingClipboard = true;
        var info = await Focus();
        readingClipboard = false;
        if (!watching) return;
        bool hidden = (bool)info["secure"]! || IsClipboardFormatAvailable(RegisterClipboardFormatW("ExcludeClipboardContentFromMonitorProcessing"));
        Emit(new { @event="pasteboard", change=sequence, hidden, image=IsClipboardFormatAvailable(2) || IsClipboardFormatAvailable(8), file=IsClipboardFormatAvailable(15), app=info.GetValueOrDefault("app"), bundleId=info.GetValueOrDefault("bundleId") });
    }
    static async void Handle(JsonElement command)
    {
        pendingCommands++;
        object? id = command.TryGetProperty("id", out var requestId) ? requestId.Clone() : null;
        try {
            string? cmd = command.GetProperty("cmd").GetString();
            switch (cmd) {
                case "setHotkey":
                    string name = command.GetProperty("name").GetString() ?? "dictate";
                    var hotkey = command.GetProperty("hotkey");
                    if (hotkey.ValueKind == JsonValueKind.Null) { Slots.Remove(name); break; }
                    int? vk = null;
                    var keyCode = hotkey.GetProperty("keyCode");
                    if (keyCode.ValueKind != JsonValueKind.Null) {
                        if (!KeyMap.TryGetValue(keyCode.GetInt32(), out int mapped)) throw new InvalidOperationException("Unsupported shortcut key");
                        vk = mapped;
                    }
                    var modifiers = hotkey.GetProperty("modifiers").EnumerateArray().Select(item => item.GetString()!).ToHashSet();
                    if (modifiers.Contains("fn")) throw new InvalidOperationException("Fn shortcuts are not available to Windows applications");
                    Slots[name] = new Slot { key=vk, modifiers=modifiers }; break;
                case "setDictating": dictating = command.GetProperty("active").GetBoolean(); break;
                case "capture": capturing = true; captureModifiers = new(Held); break;
                case "cancelCapture": capturing = false; Event("captureCancelled"); break;
                case "watchPasteboard": watching = command.GetProperty("active").GetBoolean(); clipboardSequence = GetClipboardSequenceNumber(); break;
                case "windows": Emit(new { id, windows=Windows() }); return;
                case "watchPointer": watchingPointer = command.GetProperty("active").GetBoolean(); break;
                case "browserUrl": Emit(new { id, url = await BrowserUrl(command.GetProperty("process").GetString()) }); return;
                case "focus": var focus = await Focus(); focus["id"] = id; Emit(focus); return;
                case "paste": if ((bool)(await Focus())["secure"]!) throw new InvalidOperationException("Cannot paste into an unknown or password field"); PressControl(86); break;
                case "copy": if ((bool)(await Focus())["secure"]!) throw new InvalidOperationException("Cannot copy from an unknown or password field"); PressControl(67); break;
                case "activate": using (var process = Process.GetProcessById(command.GetProperty("pid").GetInt32())) {
                    if (!SetForegroundWindow(process.MainWindowHandle)) throw new InvalidOperationException("Windows refused foreground activation");
                } break;
                case "status": Emit(new { id, @event="status", accessibility=true, tap=hook != 0 }); return;
                default: throw new InvalidOperationException($"Unknown command: {cmd}");
            }
            if (id != null) Emit(new { id, ok=true });
        } catch (Exception e) { if (id != null) Emit(new { id, ok=false, error=e.Message }); else Console.Error.WriteLine(e.Message); }
        finally { pendingCommands--; if (inputClosed && pendingCommands == 0) Forms.Application.ExitThread(); }
    }
}
