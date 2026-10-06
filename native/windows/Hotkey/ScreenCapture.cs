using System.Drawing;
using System.Drawing.Imaging;
using System.Runtime.InteropServices;
using System.Text.Json;
using Forms = System.Windows.Forms;

internal static class ScreenCapture
{
    [StructLayout(LayoutKind.Sequential)] struct NativeRect { public int left, top, right, bottom; }
    delegate bool EnumWindowsProc(nint window, nint parameter);
    [DllImport("user32.dll")] static extern int GetSystemMetrics(int index);
    [DllImport("user32.dll")] static extern bool EnumWindows(EnumWindowsProc callback,nint parameter);
    [DllImport("user32.dll")] static extern bool IsWindowVisible(nint window);
    [DllImport("user32.dll")] static extern bool IsIconic(nint window);
    [DllImport("user32.dll")] static extern bool GetWindowRect(nint window,out NativeRect bounds);
    [DllImport("dwmapi.dll")] static extern int DwmGetWindowAttribute(nint window,uint attribute,out NativeRect bounds,int size);
    [DllImport("dwmapi.dll")] static extern int DwmFlush();
    [DllImport("user32.dll")] static extern bool SetCursorPos(int x,int y);
    [DllImport("user32.dll")] static extern void mouse_event(uint flags,uint x,uint y,uint data,nuint extra);
    [DllImport("user32.dll")] static extern void keybd_event(byte key,byte scan,uint flags,nuint extra);
    static Rectangle Desktop => new(GetSystemMetrics(76),GetSystemMetrics(77),GetSystemMetrics(78),GetSystemMetrics(79));
    static Rectangle WindowAt(Point point,nint excluded)
    {
        Rectangle found=Rectangle.Empty;
        EnumWindows((window,_)=>{
            if(window==excluded||!IsWindowVisible(window)||IsIconic(window)) return true;
            if(DwmGetWindowAttribute(window,9,out var rect,Marshal.SizeOf<NativeRect>())!=0 && !GetWindowRect(window,out rect)) return true;
            var bounds=Rectangle.FromLTRB(rect.left,rect.top,rect.right,rect.bottom);
            if(!bounds.Contains(point)) return true;
            found=Rectangle.Intersect(bounds,Desktop);return false;
        },0);
        return found;
    }
    sealed class Picker : Forms.Form
    {
        Point? start;
        Rectangle selection=Rectangle.Empty;
        bool windowMode;
        public Rectangle Chosen {get;private set;}
        public Picker(Point[]? testDrag=null,int testMode=0)
        {
            AutoScaleMode=Forms.AutoScaleMode.None;FormBorderStyle=Forms.FormBorderStyle.None;
            StartPosition=Forms.FormStartPosition.Manual;Bounds=Desktop;TopMost=true;ShowInTaskbar=false;
            BackColor=Color.Black;Opacity=0.25;Cursor=Forms.Cursors.Cross;KeyPreview=true;DoubleBuffered=true;
            var expiry=new Forms.Timer{Interval=300000};expiry.Tick+=(_,_)=>Close();expiry.Start();Disposed+=(_,_)=>expiry.Dispose();
            KeyDown+=(_,eventArgs)=>{
                if(eventArgs.KeyCode==Forms.Keys.Escape){eventArgs.Handled=true;Close();}
                else if(eventArgs.KeyCode==Forms.Keys.Space){windowMode=!windowMode;start=null;selection=windowMode?WindowAt(Forms.Cursor.Position,Handle):Rectangle.Empty;Invalidate();eventArgs.Handled=true;}
            };
            MouseDown+=(_,eventArgs)=>{if(eventArgs.Button==Forms.MouseButtons.Left){start=Forms.Cursor.Position;Capture=true;}};
            MouseMove+=(_,_)=>{
                var cursor=Forms.Cursor.Position;
                if(windowMode)selection=WindowAt(cursor,Handle);
                else if(start is Point from)selection=Rectangle.FromLTRB(Math.Min(from.X,cursor.X),Math.Min(from.Y,cursor.Y),Math.Max(from.X,cursor.X),Math.Max(from.Y,cursor.Y));
                Invalidate();
            };
            MouseUp+=(_,eventArgs)=>{
                if(eventArgs.Button!=Forms.MouseButtons.Left||start==null)return;
                var cursor=Forms.Cursor.Position;
                if(windowMode)selection=WindowAt(cursor,Handle);
                else {var from=start.Value;selection=Rectangle.FromLTRB(Math.Min(from.X,cursor.X),Math.Min(from.Y,cursor.Y),Math.Max(from.X,cursor.X),Math.Max(from.Y,cursor.Y));}
                Chosen=Rectangle.Intersect(selection,Desktop);Capture=false;Close();
            };
            if(testDrag!=null) Shown+=(_,_)=>{
                int phase=0;
                var timer=new Forms.Timer{Interval=200};
                timer.Tick+=(_,_)=>{
                    if(phase==0){
                        if(testMode==2){keybd_event(27,0,0,0);keybd_event(27,0,2,0);timer.Stop();return;}
                        if(testMode==3){keybd_event(32,0,0,0);keybd_event(32,0,2,0);}
                        SetCursorPos(testDrag[0].X,testDrag[0].Y);mouse_event(2,0,0,0,0);
                    }
                    else if(phase==1)SetCursorPos(testDrag[1].X,testDrag[1].Y);
                    else {mouse_event(4,0,0,0,0);timer.Stop();}
                    phase++;
                };
                Disposed+=(_,_)=>timer.Dispose();timer.Start();
            };
        }
        protected override void OnPaint(Forms.PaintEventArgs e)
        {
            base.OnPaint(e);
            using var font=new Font("Segoe UI",12);using var text=new SolidBrush(Color.White);
            e.Graphics.DrawString("Drag an area · Space: area/window · Esc: cancel",font,text,24,24);
            if(selection.Width>0&&selection.Height>0){using var pen=new Pen(Color.White,3);var local=selection;local.Offset(-Left,-Top);e.Graphics.DrawRectangle(pen,local);}
        }
    }
    public static void Run(string output,int testMode=0)
    {
        Forms.Application.SetHighDpiMode(Forms.HighDpiMode.PerMonitorV2);
        using var sample=testMode>0?new Forms.Form{AutoScaleMode=Forms.AutoScaleMode.None,FormBorderStyle=Forms.FormBorderStyle.None,StartPosition=Forms.FormStartPosition.Manual,Bounds=new Rectangle(Forms.Screen.PrimaryScreen!.Bounds.Left+100,Forms.Screen.PrimaryScreen.Bounds.Top+100,400,300),BackColor=Color.Blue,ShowInTaskbar=false}:null;
        if(sample!=null){sample.Show();Forms.Application.DoEvents();}
        Point[]? drag=sample==null?null:[new Point(sample.Left+30,sample.Top+30),new Point(sample.Left+230,sample.Top+150)];
        using var picker=new Picker(drag,testMode);picker.ShowDialog();
        var area=picker.Chosen;
        if(area.Width<2||area.Height<2){Console.WriteLine(JsonSerializer.Serialize(new{cancelled=true,selfTest=testMode>0}));return;}
        if(testMode==2)throw new InvalidOperationException("Escape did not cancel the area picker.");
        DwmFlush();Thread.Sleep(80);
        using var bitmap=new Bitmap(area.Width,area.Height,PixelFormat.Format24bppRgb);
        using(var graphics=Graphics.FromImage(bitmap))graphics.CopyFromScreen(area.Location,Point.Empty,area.Size,CopyPixelOperation.SourceCopy);
        var expected=testMode==3?new Size(400,300):new Size(200,120);
        if(testMode>0 && (area.Size!=expected||bitmap.GetPixel(area.Width/2,area.Height/2).ToArgb()!=Color.Blue.ToArgb()))throw new InvalidOperationException("Area capture dimensions or desktop pixels did not match the test window.");
        bitmap.Save(output,ImageFormat.Png);
        Console.WriteLine(JsonSerializer.Serialize(new{cancelled=false,width=area.Width,height=area.Height,selfTest=testMode>0}));
    }
}
