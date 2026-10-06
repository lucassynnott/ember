using System.Diagnostics;
using System.Runtime.InteropServices;
using System.Text;
using System.Text.Json;
using NAudio.CoreAudioApi;
using NAudio.CoreAudioApi.Interfaces;

internal static class AudioApps
{
    delegate bool EnumWindowsProc(nint window,nint parameter);
    [DllImport("user32.dll")] static extern bool EnumWindows(EnumWindowsProc callback,nint parameter);
    [DllImport("user32.dll")] static extern bool IsWindowVisible(nint window);
    [DllImport("user32.dll")] static extern uint GetWindowThreadProcessId(nint window,out uint pid);
    [DllImport("user32.dll",CharSet=CharSet.Unicode)] static extern int GetWindowTextW(nint window,StringBuilder text,int length);
    sealed class AppState
    {
        public string bundleId {get;set;}="";
        public string name {get;set;}="";
        public bool input {get;set;}
        public bool output {get;set;}
        public List<string> titles {get;set;}=[];
    }
    static string? ProcessName(uint pid)
    {
        try {using var process=Process.GetProcessById(checked((int)pid));return process.ProcessName.ToLowerInvariant();}
        catch {return null;}
    }
    static List<AppState> Snapshot()
    {
        var apps=new Dictionary<string,AppState>();
        using var devices=new MMDeviceEnumerator();
        foreach(var flow in new[]{DataFlow.Capture,DataFlow.Render})
        foreach(var device in devices.EnumerateAudioEndPoints(flow,DeviceState.Active))
        using(device)
        {
            try {
                var sessions=device.AudioSessionManager.Sessions;
                for(int index=0;index<sessions.Count;index++)
                {
                    using var session=sessions[index];
                    if(session.State!=AudioSessionState.AudioSessionStateActive)continue;
                    var name=ProcessName(session.GetProcessID);
                    if(name==null)continue;
                    if(!apps.TryGetValue(name,out var app))apps[name]=app=new AppState{bundleId="windows:"+name,name=name};
                    if(flow==DataFlow.Capture)app.input=true;else app.output=true;
                }
            } catch(Exception error){Console.Error.WriteLine("Audio endpoint unavailable: "+error.Message);}
        }
        EnumWindows((window,_)=>{
            if(!IsWindowVisible(window))return true;
            GetWindowThreadProcessId(window,out var pid);
            var name=ProcessName(pid);
            if(name==null||!apps.TryGetValue(name,out var app))return true;
            var title=new StringBuilder(1024);GetWindowTextW(window,title,title.Capacity);
            if(title.Length>0&&!app.titles.Contains(title.ToString()))app.titles.Add(title.ToString());
            return true;
        },0);
        return apps.Values.OrderBy(app=>app.bundleId).ToList();
    }
    public static void Run(bool once=false)
    {
        Console.OutputEncoding=new UTF8Encoding(false);
        string? previous=null;
        do {
            var apps=Snapshot();
            var json=JsonSerializer.Serialize(apps);
            if(json!=previous){Console.WriteLine("{\"type\":\"audio-apps\",\"apps\":"+json+"}");Console.Out.Flush();previous=json;}
            if(once)return;
            Thread.Sleep(500);
        } while(true);
    }
}
